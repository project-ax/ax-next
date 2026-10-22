import {
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS, MemoryPreCapturePayloadSchema, reject, type AgentContext, type Rejection,
} from '@ax/core';
import type { RoutinesStore } from './store.js';

// ---------------------------------------------------------------------------
// TASK-908 decisions row 14: memory doesn't learn from a task check-in. Its
// user turn is the check-in message, which holds the agent's own notes and
// reports. Extracted, that would be recalled in later chats as things the
// person said, by every member of a team agent, and would outlive the person
// clearing the task's notes.
// ---------------------------------------------------------------------------

/**
 * How long the capture check may take before it refuses anyway: half of
 * memory's own bound (`MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS`, in core). A
 * subscriber past that bound is skipped by the bus and the pass goes on, so
 * the answer has to arrive first for a slow lookup to fail closed.
 */
export const CAPTURE_CHECK_DEADLINE_MS = MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS / 2;

/**
 * The `memory:pre-capture` veto. Keyed on the conversation, never on who is
 * asking: a pass under any source on a task check-in's conversation is
 * refused, because memory leaves its cursor where a refusal stopped it and
 * the next pass that got through would read every check-in turn the refusals
 * skipped. It asks about the host-set `ctx.conversationId` and, when an
 * earlier subscriber rewrote the payload to name another, that one too: a
 * task conversation under either is refused.
 *
 * Fails closed: a lookup that throws, or takes longer than `deadlineMs`,
 * refuses too. A refusal costs memory nothing but time (the cursor stays put,
 * so a later pass reads those turns), which is why refusing an ordinary
 * chat's pass while the database is slow is the cheap mistake.
 */
export async function taskCaptureVeto(
  store: Pick<RoutinesStore, 'isTaskConversation'>,
  ctx: AgentContext,
  payload: unknown,
  deadlineMs = CAPTURE_CHECK_DEADLINE_MS,
): Promise<Rejection | undefined> {
  const refusal = reject({ reason: 'task-check-in' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Read inside the try: a payload an earlier subscriber rewrote into
    // something that throws when read is refused, not skipped by the bus.
    const parsed = MemoryPreCapturePayloadSchema.safeParse(payload);
    const ids = new Set<string>();
    if (ctx.conversationId !== undefined && ctx.conversationId.length > 0) ids.add(ctx.conversationId);
    if (parsed.success) ids.add(parsed.data.conversationId);
    if (ids.size === 0) return undefined;
    const deadline = new Promise<never>((_resolve, rejectDeadline) => {
      timer = setTimeout(() => rejectDeadline(new Error(`capture check took longer than ${deadlineMs} ms`)), deadlineMs);
      timer.unref?.();
    });
    const answers = await Promise.race([
      Promise.all([...ids].map(conversationId => store.isTaskConversation({ agentId: ctx.agentId, conversationId }))),
      deadline,
    ]);
    if (!answers.some(Boolean)) return undefined;
  } catch (err) {
    // Logged after the refusal is built: a logger that throws can't turn it into a skipped subscriber.
    try {
      ctx.logger.warn('routines_capture_check_failed', { agentId: ctx.agentId, err: err instanceof Error ? err.message : String(err) });
    } catch { /* the refusal stands */ }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return refusal;
}
