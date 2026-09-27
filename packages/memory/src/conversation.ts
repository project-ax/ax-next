import type { AgentContext } from '@ax/core';

/**
 * The conversation a statement written under `ctx` is attributed to — or
 * `undefined` when it belongs to none.
 *
 * ## A routine run is not a conversation the person had (TASK-616)
 *
 * `MemoryStatement.conversation` exists so recurrence — "this showed up in 2+
 * distinct conversations", the gate the skill-reflection routine reads — can
 * be answered from `memory:recall` alone. Every routine fire, skill-reflection
 * included, runs in its own hidden conversation. Attributing its rows to that
 * conversation let each reflection pass that merely RESTATED a procedure it
 * found in recall add a conversation of its own: three passes over a one-off
 * procedure read as four conversations and cleared the gate by themselves.
 *
 * So a routine turn's rows are still STORED, under the routine owner (design
 * §3.2, `owner.ts`) — only their conversation is left off, which is exactly
 * the "recorded outside a conversation" state the recall surface already
 * renders as `-` and does not count. The alternative, skipping routine turns
 * in the observer outright, would drop facts design §3.2 chose to keep, and
 * would still leave `memory_note` / `memory:remember` calls made during a
 * routine counting its conversation — one rule at every writer is the smaller
 * and the complete fix.
 *
 * `ctx.source` is stamped host-side by the routine fire path and carried
 * through the session, never taken from a runner frame (`ipc-server`'s
 * listener), so an untrusted runner cannot use it to reattribute rows.
 *
 * This is the STORED provenance only. The observer's batch idempotency key
 * still hashes `ctx.conversationId` itself, so two routine fires with a
 * byte-identical transcript remain two batches (see `buildBatchKey`).
 */
export function conversationOf(
  ctx: Pick<AgentContext, 'conversationId' | 'source'>,
): string | undefined {
  if (ctx.source === 'routine') return undefined;
  return ctx.conversationId;
}

/**
 * `conversationOf(ctx)` as a spreadable field: `{ conversationId }`, or `{}`
 * — absent rather than faked when there is none.
 */
export function conversationField(
  ctx: Pick<AgentContext, 'conversationId' | 'source'>,
): { conversationId?: string } {
  const conversationId = conversationOf(ctx);
  return conversationId !== undefined ? { conversationId } : {};
}
