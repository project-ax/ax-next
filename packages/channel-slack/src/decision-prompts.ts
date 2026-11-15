import type { AgentContext, HookBus, Logger } from '@ax/core';
import { logCode } from './log-code.js';

/**
 * Calls held for a person's OK, in Slack (TASK-1095): @ax/decisions holds a
 * call the policy says needs approval, and a DM or an attended channel turn
 * that held one posts a prompt for it after the reply (turn.ts), so the
 * person who wrote can answer it right there.
 *
 * `findHeldDecision` says which decision a held call is. The held tool
 * result names only its call (the runner's `toolCallId`), never a decision,
 * but decisions wrote the decision before the runner even saw the hold, so
 * the turn asks decisions for its conversation's recent decisions and takes
 * the PENDING one whose recorded call has that id. Anything else is no
 * prompt, and the reply keeps its Today link:
 *   - no decisions service (a kernel booted without it, like the CLI's reset);
 *   - no such decision. A call identical to one already waiting reuses that
 *     decision, which keeps the first call's id: a miss, on purpose;
 *   - a lookup that fails, answers what we can't read, or outlasts its
 *     deadline. Logged by code (`slack_prompt_failed`, stage `lookup`).
 *
 * The answer is another plugin's output, so every field read from it is
 * checked with typeof. The summary is kept exactly as decisions wrote it:
 * host-authored, but outside text to Slack, so whoever shows it cleans it
 * (blocks.ts), and nothing here does.
 */

/** The held call's decision: what the prompt is about, and the line it shows. */
export interface HeldDecision {
  decisionId: string;
  /** The decision's one-line summary (decisions/src/templates.ts), raw. */
  summary: string;
}

const RECENT = 'decisions:recent-for-conversation';

/** A lookup that took longer than its deadline. Its code is all that is logged. */
class LookupTimeout extends Error {
  readonly code = 'timeout';
  constructor() {
    super('channel-slack: the held call lookup took too long');
    this.name = 'LookupTimeout';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The pending decision for the held call `q.toolCallId`, in the turn's own
 * conversation, read under the turn's `ctx` (decisions only lets a turn read
 * its own user's and agent's). Null when there is none, or it can't be found
 * within `timeoutMs`. Never rejects.
 */
export async function findHeldDecision(
  bus: HookBus,
  ctx: AgentContext,
  q: { userId: string; agentId: string; conversationId: string; toolCallId: string },
  timeoutMs: number,
  log: { installId: string; logger: Logger },
): Promise<HeldDecision | null> {
  const failed = (code: string): null => {
    try {
      log.logger.warn('slack_prompt_failed', { installId: log.installId, stage: 'lookup', code });
    } catch {
      // A log line never changes the turn.
    }
    return null;
  };
  // A held result with no call id names no decision.
  if (typeof q.toolCallId !== 'string' || q.toolCallId.length === 0) return null;
  if (!bus.hasService(RECENT)) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LookupTimeout()), timeoutMs);
    timer.unref?.();
  });
  let out: unknown;
  try {
    out = await Promise.race([
      bus.call<{ userId: string; agentId: string; conversationId: string }, unknown>(RECENT, ctx, {
        userId: q.userId,
        agentId: q.agentId,
        conversationId: q.conversationId,
      }),
      deadline,
    ]);
  } catch (err) {
    return failed(logCode(err));
  } finally {
    clearTimeout(timer);
  }

  const rows = isRecord(out) ? out['decisions'] : undefined;
  if (!Array.isArray(rows)) return failed('bad-response');
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { id, status, summary, call } = row;
    if (typeof id !== 'string' || id.length === 0 || typeof summary !== 'string') continue;
    if (status !== 'pending' || !isRecord(call) || call['id'] !== q.toolCallId) continue;
    return { decisionId: id, summary };
  }
  return null;
}
