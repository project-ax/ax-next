import { makeAgentContext, makeReqId, type AgentMessage, type HookBus, type Logger } from '@ax/core';
import { COPY } from './copy.js';
import { decodeSlackEntities, dmSenderLabel } from './format.js';
import { TURN_END_GRACE_MS, TURN_HARD_CAP_MS } from './limits.js';
import { logCode } from './log-code.js';
import { createReplyStream, type ReplyClock, type ReplyOutcome } from './reply-stream.js';
import type { SlackApi } from './slack-api.js';
import type { InstallRow } from './store.js';
import type { StreamChunkIn, TurnRegistry } from './turn-registry.js';

/**
 * One DM turn: the owner's message to their own personal agent, the reply
 * streamed back into the Slack thread (design §5).
 *
 * The turn's context is built here, by the host, from what admission and AX
 * decided (never from the message): the mapped user, their agent, the
 * thread's conversation, `source: 'user'` (the owner is present, so approvals
 * work as in web chat) and `audience: 'private'` (a 1:1 DM; constant for the
 * conversation, as memory requires). The Slack sender label is part of the
 * message CONTENT: untrusted text the model reads, nothing more.
 *
 * The reply ends at the first of: the turn's `chat:turn-end` (complete), its
 * `chat:turn-error` (error), a `terminated` invoke outcome
 * (`conversation:busy` → busy, never retried; anything else → error), a
 * thrown invoke (error), TURN_END_GRACE_MS after a complete invoke whose
 * turn-end never came (complete), or TURN_HARD_CAP_MS (error). Failures are
 * logged as `slack_turn_failed` with a reason and a host code, never text.
 *
 * The cap ends the TURN too, not only its reply: the turn is asked to stop
 * (`agent:interrupt`, best-effort), so a turn nobody will see the end of
 * doesn't run, and spend, on for hours.
 */

export interface DmTurnDeps {
  bus: HookBus;
  api: SlackApi;
  registry: TurnRegistry;
  /** The web app's origin, for links in the bot's own lines. */
  publicOrigin: string;
  logger: Logger;
  clock: ReplyClock;
}

export interface DmTurnRequest {
  install: InstallRow;
  botToken: string;
  channel: string;
  threadTs: string;
  /** The sender's Slack user id: the reply's recipient, and part of the label. */
  senderSlackId: string;
  /** Their Slack display name, already cleaned ('' for none). Label text only. */
  senderName: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /**
   * The owner's words as Slack sent them. The turn undoes Slack's `&amp;`,
   * `&lt;` and `&gt;` (format.ts `decodeSlackEntities`) and nothing else.
   */
  text: string;
}

interface AgentChoice {
  id: string;
  ownerId: string;
  ownerType: string;
  visibility: string;
  createdAt: Date;
}

/**
 * The sender's own personal agent: owned by them (`ownerType 'user'`,
 * `ownerId === userId`) with `visibility 'personal'`, the OLDEST by
 * `createdAt`, ties broken by id. Never a team agent, never someone else's.
 * An agent whose date can't be read sorts after every dated one. Null when
 * they have none.
 */
export function pickPersonalAgent(agents: ReadonlyArray<AgentChoice>, userId: string): string | null {
  let best: { id: string; at: number } | null = null;
  for (const a of agents) {
    if (a.ownerType !== 'user' || a.visibility !== 'personal' || a.ownerId !== userId) continue;
    const time = a.createdAt instanceof Date ? a.createdAt.getTime() : Number.NaN;
    const at = Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
    if (best === null || at < best.at || (at === best.at && a.id < best.id)) best = { id: a.id, at };
  }
  return best?.id ?? null;
}

/**
 * Tools whose result is something to open in the web app: both spellings,
 * since the runner serves them over its sandbox MCP server.
 */
const ARTIFACT_TOOLS = new Set([
  'artifact_publish',
  'show_visual',
  'mcp__ax-sandbox-tools__artifact_publish',
  'mcp__ax-sandbox-tools__show_visual',
]);

/**
 * A host code (`conversation:busy`, `chat-run-timeout`,
 * `agent-resolve:forbidden`). A terminated reason can be the runner's own
 * error text, so anything else is logged as `runner-error`.
 *
 * The same pattern as `HOST_REASON_RE` in @ax/chat-orchestrator
 * (packages/chat-orchestrator/src/orchestrator.ts, `outsiderReason`) and in
 * @ax/routines (packages/routines/src/fire.ts, `terminatedRunText`), where
 * the reason for its shape is spelled out. Change all three together; no
 * cross-plugin import.
 */
const HOST_CODE = /^[a-z0-9][a-z0-9:-]{0,63}$/;
const BUSY = 'conversation:busy';
/** chat-orchestrator's Stop (TASK-688): optional, so a preset without it still boots. */
const INTERRUPT = 'agent:interrupt';

type FailReason = 'busy' | 'terminated' | 'invoke-failed' | 'turn-error' | 'timeout';

interface Decision {
  outcome: ReplyOutcome;
  fail?: { reason: FailReason; code?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The newlines that make `next` start a paragraph after text ending in `tail`; none it already has. */
function paragraphBreak(tail: string, next: string): string {
  const have = (/\n*$/.exec(tail)?.[0].length ?? 0) + (/^\n*/.exec(next)?.[0].length ?? 0);
  return '\n'.repeat(Math.max(0, 2 - have));
}

/** Run one DM turn to the end of its reply. Never rejects. */
export async function runDmTurn(d: DmTurnDeps, r: DmTurnRequest): Promise<void> {
  const installId = r.install.installId;
  const quietly = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // A log line never changes the turn.
    }
  };

  const reqId = makeReqId();
  const ctx = makeAgentContext({
    sessionId: makeReqId(),
    reqId,
    agentId: r.agentId,
    userId: r.userId,
    conversationId: r.conversationId,
    source: 'user',
    audience: 'private',
  });

  let replyLogger = d.logger;
  quietly(() => {
    replyLogger = d.logger.child({ installId });
  });
  const stream = createReplyStream({
    api: d.api,
    botToken: r.botToken,
    target: {
      channel: r.channel,
      threadTs: r.threadTs,
      recipientUserId: r.senderSlackId,
      recipientTeamId: r.install.teamId ?? '',
    },
    agentLink: `${d.publicOrigin}/workspace/agents/${encodeURIComponent(r.agentId)}`,
    logger: replyLogger,
    clock: d.clock,
  });

  let decided = false;
  let settle!: (decision: Decision) => void;
  const decision = new Promise<Decision>((resolve) => {
    settle = resolve;
  });
  const decide = (next: Decision): void => {
    if (decided) return;
    decided = true;
    settle(next);
  };

  const toolNames = new Map<string, string>();
  /**
   * Text after other work (a tool call, a status, thinking) starts a new
   * paragraph. claude-sdk sends whole text blocks, so without this the block
   * after a tool call is glued to the one before ("…handling.Done!"). Inside
   * one uninterrupted run nothing is added: aisdk sends word-sized deltas.
   */
  let textTail = '';
  let otherSinceText = false;
  const onChunk = (c: StreamChunkIn): void => {
    if (c.kind !== 'text') {
      if (textTail !== '') otherSinceText = true;
    } else if (c.text !== undefined && c.text !== '') {
      const text = otherSinceText ? paragraphBreak(textTail, c.text) + c.text : c.text;
      otherSinceText = false;
      textTail = (textTail + text).slice(-2);
      stream.text(text);
      return;
    }
    switch (c.kind) {
      case 'text':
        return;
      case 'tool-use':
        if (c.toolCallId !== undefined && c.toolName !== undefined) toolNames.set(c.toolCallId, c.toolName);
        stream.status(c.activityPhrase ?? COPY.statusDefault);
        return;
      case 'step-summary':
        if (c.text !== undefined) stream.status(c.text);
        return;
      case 'tool-result': {
        if (c.isError === true || c.held === true || c.toolCallId === undefined) return;
        const tool = toolNames.get(c.toolCallId);
        if (tool !== undefined && ARTIFACT_TOOLS.has(tool)) stream.artifact();
        return;
      }
      default:
        // `thinking` stays private, and a kind this build doesn't know is skipped.
        return;
    }
  };

  // Registered before agent:invoke: a fast turn's first chunk can beat the call's return.
  const unregister = d.registry.register({
    reqId,
    conversationId: r.conversationId,
    chunk: onChunk,
    end: () => decide({ outcome: 'complete' }),
    error: () => decide({ outcome: 'error', fail: { reason: 'turn-error' } }),
  });
  /**
   * Ask chat-orchestrator to stop the conversation's in-flight turn: the
   * same Stop the web app's button sends (`{ conversationId, userId }`; it
   * re-checks ownership itself). Best-effort and logged by code: the reply
   * ends either way. `interrupted: false` means nothing was running by then.
   * Never rejects.
   */
  const interruptTurn = async (): Promise<void> => {
    try {
      if (!d.bus.hasService(INTERRUPT)) {
        quietly(() => d.logger.warn('slack_turn_interrupt_failed', { installId, code: 'unavailable' }));
        return;
      }
      const out = await d.bus.call<{ conversationId: string; userId: string }, unknown>(INTERRUPT, ctx, {
        conversationId: r.conversationId,
        userId: r.userId,
      });
      const interrupted = isRecord(out) && out['interrupted'] === true;
      quietly(() => d.logger.info('slack_turn_interrupted', { installId, reason: 'timeout', interrupted }));
    } catch (err) {
      quietly(() => d.logger.warn('slack_turn_interrupt_failed', { installId, code: logCode(err) }));
    }
  };
  /*
    The stop the cap sent, awaited before this turn returns. The lane is
    released when this function returns, and the orchestrator stops "the
    conversation's in-flight turn": released first, the next queued DM in the
    thread could start before the stop lands and be the turn it stops.
  */
  let interrupting: Promise<void> | null = null;
  const cap = d.clock.setTimeout(() => {
    // A turn that already ended is not stopped again.
    if (decided) return;
    decide({ outcome: 'error', fail: { reason: 'timeout' } });
    // Sent now, not after the reply: the turn is still burning until it lands.
    interrupting = interruptTurn();
  }, TURN_HARD_CAP_MS);
  let grace: unknown = null;

  const message: AgentMessage = {
    role: 'user',
    // As the owner typed it: `if x &lt; 3` reaches the model as `if x < 3`.
    content: `${dmSenderLabel(r.senderName, r.senderSlackId)}: ${decodeSlackEntities(r.text)}`,
  };
  void (async () => {
    try {
      const outcome = await d.bus.call<{ message: AgentMessage }, unknown>('agent:invoke', ctx, { message });
      if (isRecord(outcome) && outcome['kind'] === 'terminated') {
        const raw = outcome['reason'];
        const code = typeof raw === 'string' && HOST_CODE.test(raw) ? raw : 'runner-error';
        // Busy: the conversation's session is running a turn of another
        // mode. Say so and back off; a retry would pay its costs again.
        decide(
          code === BUSY
            ? { outcome: 'busy', fail: { reason: 'busy', code } }
            : { outcome: 'error', fail: { reason: 'terminated', code } },
        );
        return;
      }
      // Complete: the turn-end decides. Should it never come, finish anyway.
      if (!decided) {
        grace = d.clock.setTimeout(() => decide({ outcome: 'complete' }), TURN_END_GRACE_MS);
      }
    } catch (err) {
      decide({ outcome: 'error', fail: { reason: 'invoke-failed', code: logCode(err) } });
    }
  })();

  const { outcome, fail } = await decision;
  d.clock.clearTimeout(cap);
  if (grace !== null) d.clock.clearTimeout(grace);
  unregister();
  if (fail !== undefined) {
    quietly(() =>
      d.logger.warn('slack_turn_failed', {
        installId,
        reason: fail.reason,
        ...(fail.code !== undefined ? { code: fail.code } : {}),
      }),
    );
  }
  try {
    await stream.finish(outcome);
  } finally {
    // The owner has their reply; the lane waits for the stop (see `interrupting`).
    if (interrupting !== null) await interrupting;
  }
}
