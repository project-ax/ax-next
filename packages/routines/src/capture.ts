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
 * The `memory:pre-capture` veto. Asks only about routine runs: anything else
 * isn't routines' call, and costs no query. A routine run's conversation (the
 * payload's, else the context's) is refused when it belongs to a task's run.
 * Fails closed: a lookup that throws refuses too.
 */
export async function taskCaptureVeto(
  store: Pick<RoutinesStore, 'isTaskConversation'>,
  ctx: AgentContext,
  payload: unknown,
): Promise<Rejection | undefined> {
  if (ctx.source !== 'routine') return undefined;
  const parsed = MemoryPreCapturePayloadSchema.safeParse(payload);
  const conversationId = parsed.success ? parsed.data.conversationId : ctx.conversationId;
  if (conversationId === undefined || conversationId.length === 0) return undefined;
  try {
    if (!await store.isTaskConversation({ agentId: ctx.agentId, conversationId })) return undefined;
  } catch (err) {
    ctx.logger.warn('routines_capture_check_failed', { agentId: ctx.agentId, err: err instanceof Error ? err.message : String(err) });
  }
  return reject({ reason: 'task-check-in' });
}
