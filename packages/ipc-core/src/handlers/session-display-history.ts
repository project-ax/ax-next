import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import {
  SessionGetDisplayHistoryRequestSchema,
  type AgentMessage,
  type ContentBlock,
} from '@ax/ipc-protocol';
import {
  hookRejected,
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// session.get-display-history — cross-runner history reconstruction.
// Design: docs/plans/2026-08-21-cross-runner-history-reconstruction.md
//
// Called on exactly one path: a runner handed a transcript that a DIFFERENT
// runner wrote (`TranscriptSource.write()` answered `'unusable'`). Without this
// it starts blank, and the user is left looking at a conversation on screen
// that the agent cannot remember — measured on kind, 2026-08-21: after a
// runner switch the agent answered `NO-HISTORY` to a question about its own
// first turn.
//
// SECURITY, mirroring session-transcript.ts:
//
//   - The conversationId is NEVER taken from the request body. The body is
//     empty by schema. It is resolved host-side from the runner's own session
//     row (bearer token → ctx.sessionId → `session:get-config`), so a runner
//     cannot read a conversation that is not its own.
//   - The blocks are an UNTRUSTED model/user artifact. They are filtered and
//     re-shaped here, never executed, never interpolated into a command.
//   - ROLES ARE PRESERVED FAITHFULLY. A `tool` turn is dropped, never
//     relabelled `user` — relabelling would let tool output impersonate the
//     user in the reconstructed context, which is a prompt-injection primitive
//     rather than a formatting choice.
//
// WHY THE FILTER LIVES HERE, not in each runner:
//
//   - A `tool_use` without its matching `tool_result` is a 400 from Anthropic,
//     not a degraded answer, and the display log splits the pair across turns.
//     Not sending them is what makes v1 safe with no re-pairing pass.
//   - Anthropic's `thinking` blocks are SIGNED over the block. A reconstructed
//     one cannot be re-signed and must never be replayed.
//
// Filtering host-side means every runner inherits both guarantees instead of
// each being trusted to re-derive them.
// ---------------------------------------------------------------------------

/**
 * Newest-N bound. A reconstruction is a best-effort courtesy, not a transcript:
 * it must never be the reason a turn blows the context window on its first
 * send. Compaction handles growth from there.
 */
const MAX_MESSAGES = 100;

/** Total character budget across the reconstruction, oldest dropped first. */
const MAX_TOTAL_CHARS = 60_000;

/** Per-message clamp, so one enormous turn cannot consume the whole budget. */
const MAX_MESSAGE_CHARS = 4_000;

interface BusSessionGetConfigOutput {
  conversationId: string | null;
}

interface ConversationsGetCall {
  conversationId: string;
  userId: string;
}

interface ConversationsGetResult {
  turns: Array<{ role: string; contentBlocks: ContentBlock[] }>;
}

async function resolveConversationId(
  ctx: AgentContext,
  bus: HookBus,
): Promise<string | null> {
  const cfg = await bus.call<Record<string, never>, BusSessionGetConfigOutput>(
    'session:get-config',
    ctx,
    {},
  );
  return cfg.conversationId;
}

/**
 * The text a turn contributes, or `''` when it contributes nothing we may
 * replay.
 *
 * Only `text` blocks survive. Everything else is dropped on purpose — see the
 * file header for why `tool_use` / `tool_result` / `thinking` in particular
 * cannot be replayed safely.
 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

function clamp(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n[…turn truncated for the history summary]`;
}

/**
 * Turns → replayable messages, newest-first bounded then restored to
 * chronological order.
 *
 * Exported for unit test: the bounds and the role filter are the whole
 * security-relevant surface of this handler, and they are far easier to pin
 * directly than through a live IPC round trip.
 */
export function buildDisplayHistory(
  turns: readonly { role: string; contentBlocks: ContentBlock[] }[],
): { messages: AgentMessage[]; truncated: boolean } {
  // Walk newest-first so the bounds drop the OLDEST content, which is what a
  // reader expects "your earlier history was trimmed" to mean.
  const picked: AgentMessage[] = [];
  let total = 0;
  let truncated = false;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    // Roles are preserved, never remapped. A `tool` turn has no faithful
    // representation in a user/assistant history, so it is dropped.
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;

    const text = clamp(textOf(turn.contentBlocks));
    if (text.length === 0) continue;

    if (picked.length >= MAX_MESSAGES || total + text.length > MAX_TOTAL_CHARS) {
      // Something older than this exists but does not fit.
      truncated = true;
      break;
    }
    total += text.length;
    picked.push({ role: turn.role, content: text });
  }

  picked.reverse();
  return { messages: picked, truncated };
}

export const sessionGetDisplayHistoryHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = SessionGetDisplayHistoryRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`session.get-display-history: ${parsed.error.message}`);
  }

  let conversationId: string | null;
  try {
    conversationId = await resolveConversationId(ctx, bus);
  } catch (err) {
    logInternalError(ctx.logger, 'session.get-display-history', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }
  if (conversationId === null) {
    // A non-conversation session (CLI, canary) has no display log to rebuild
    // from. Not an error — the runner falls back to starting fresh.
    return hookRejected('session is not conversation-scoped');
  }

  let out: ConversationsGetResult;
  try {
    out = await bus.call<ConversationsGetCall, ConversationsGetResult>(
      'conversations:get',
      ctx,
      { conversationId, userId: ctx.userId },
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.get-display-history', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  return { status: 200, body: buildDisplayHistory(out.turns) };
};
