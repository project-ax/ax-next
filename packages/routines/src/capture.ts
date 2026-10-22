import { MemoryPreCapturePayloadSchema, reject, type AgentContext, type Rejection } from '@ax/core';
import type { RoutinesStore } from './store.js';

// ---------------------------------------------------------------------------
// TASK-908 decisions row 14: memory doesn't learn from a task check-in. Its
// user turn is the check-in message, which holds the agent's own notes and
// reports. Extracted, that would be recalled in later chats as things the
// person said, by every member of a team agent, and would outlive the person
// clearing the task's notes.
// ---------------------------------------------------------------------------

/**
 * How long the capture check may take before it refuses anyway. Shorter than
 * memory's own bound (`MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS`, 10 s): a
 * subscriber past that bound is skipped by the bus and the pass goes on, so
 * the answer has to arrive first for a slow lookup to fail closed.
 */
export const CAPTURE_CHECK_DEADLINE_MS = 5_000;

/**
 * The `memory:pre-capture` veto. Keyed on the conversation (the payload's,
 * else the context's), never on who is asking: a pass under any source on a
 * task check-in's conversation is refused, because memory leaves its cursor
 * where a refusal stopped it and the next pass that got through would read
 * every check-in turn the refusals skipped.
 *
 * Fails closed: a lookup that throws, or takes longer than
 * `CAPTURE_CHECK_DEADLINE_MS`, refuses too. A refusal costs memory nothing
 * but time (the cursor stays put, so a later pass reads those turns), which
 * is why refusing an ordinary chat's pass while the database is slow is the
 * cheap mistake.
 */
export async function taskCaptureVeto(
  store: Pick<RoutinesStore, 'isTaskConversation'>,
  ctx: AgentContext,
  payload: unknown,
  deadlineMs = CAPTURE_CHECK_DEADLINE_MS,
): Promise<Rejection | undefined> {
  const parsed = MemoryPreCapturePayloadSchema.safeParse(payload);
  const conversationId = parsed.success ? parsed.data.conversationId : ctx.conversationId;
  if (conversationId === undefined || conversationId.length === 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, rejectDeadline) => {
      timer = setTimeout(() => rejectDeadline(new Error(`capture check took longer than ${deadlineMs} ms`)), deadlineMs);
      timer.unref?.();
    });
    const isTask = await Promise.race([store.isTaskConversation({ agentId: ctx.agentId, conversationId }), deadline]);
    if (!isTask) return undefined;
  } catch (err) {
    ctx.logger.warn('routines_capture_check_failed', { agentId: ctx.agentId, err: err instanceof Error ? err.message : String(err) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return reject({ reason: 'task-check-in' });
}
