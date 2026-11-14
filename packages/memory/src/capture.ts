import {
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  type AgentContext,
  type HookBus,
  type MemoryPreCapturePayload,
  type Rejection,
} from '@ax/core';

/**
 * Logged at `info` when a `memory:pre-capture` subscriber refuses (TASK-908).
 * Bindings: `agentId`, `refusedBy` (the subscriber), `reason` (its own word
 * for why), plus `trigger` for an extraction pass or `tool` for a note. Ids
 * and codes only, never conversation text.
 */
export const CAPTURE_REFUSED_EVENT = 'memory_capture_refused';

/**
 * Asks whether memory may learn from `ctx`'s conversation (TASK-908).
 * Resolves the refusal, or `undefined` to go on.
 *
 * Every extraction pass asks (`observe()` in plugin.ts), and since TASK-1094
 * so does `memory_note` before it writes, so a plugin that keeps a
 * conversation out of memory keeps the agent's own notes out too. One ask for
 * both, so they can't drift apart:
 *
 * - It asks about `ctx.conversationId` as the host set it, not
 *   `conversationOf(ctx)`. A routine run's rows are stored with no
 *   conversation (TASK-616), but a task check-in is refused by the
 *   conversation it runs in.
 * - No conversation, nothing to refuse: it doesn't ask.
 * - Each subscriber gets MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS. One that
 *   throws, or misses the bound, is skipped by the bus and is no refusal
 *   (fails open; a subscriber that must fail closed refuses inside the
 *   bound, as @ax/routines does).
 * - If the fire itself throws, so does this, and the caller records nothing.
 */
export async function captureRefusal(
  bus: HookBus,
  ctx: AgentContext,
): Promise<Rejection | undefined> {
  const conversationId = ctx.conversationId;
  if (typeof conversationId !== 'string' || conversationId === '') return undefined;
  const asked = await bus.fire<MemoryPreCapturePayload>(
    MEMORY_PRE_CAPTURE_HOOK,
    ctx,
    { conversationId },
    { subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS },
  );
  return asked.rejected ? asked : undefined;
}
