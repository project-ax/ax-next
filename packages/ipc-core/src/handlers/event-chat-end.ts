import type { AgentContext, HookBus } from '@ax/core';
import { EventChatEndSchema, type EventChatEnd } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.chat-end
//
// Fire-and-forget. The `chat:end` hook is what @ax/audit-log listens to for
// durable persistence of chat outcomes — any change to the payload shape here
// breaks audit-log silently. The wire shape is `{ outcome: AgentOutcome }`
// and the hook fires with the same key name, matching chat-loop.ts.
// ---------------------------------------------------------------------------

/**
 * The bound on EACH subscriber of the runner-reported `chat:end` (TASK-555).
 *
 * This is the happy-path `chat:end`: the runner POSTs `event.chat-end`, the
 * dispatcher acks it with a 202, and then fires this hook detached. One of its
 * subscribers is @ax/chat-orchestrator's, which resolves the waiting
 * `agent:invoke` with the runner's outcome. Subscribers run in registration
 * order, so before this bound a subscriber registered AHEAD of the
 * orchestrator's that never settled kept the orchestrator's from ever running:
 * a turn the runner had finished sat until `chatTimeoutMs` (10 min by default)
 * and was then reported as `chat-run-timeout`.
 *
 * Now a subscriber still running at the bound is skipped (logged as
 * `hook_subscriber_timed_out`, its `signal` aborted — see HookBus.fire) and
 * the rest run, so the turn ends with the outcome the runner reported, at most
 * this long late per hung subscriber.
 *
 * WHY 30 s. The same number, for the same reasons, as the orchestrator's
 * `CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS`, which bounds every `chat:end` the
 * orchestrator synthesizes itself: twice the bus's 15 s stall watch, and each
 * subscriber's healthy work is one frame or row write or a detached kick-off.
 * It is a separate constant because a plugin cannot import another plugin's.
 */
export const RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS = 30_000;

export function validateEventChatEnd(rawPayload: unknown):
  | { ok: true; payload: EventChatEnd }
  | HandlerErr {
  const parsed = EventChatEndSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.chat-end: ${parsed.error.message}`);
  }
  return { ok: true, payload: parsed.data };
}

/**
 * Fire the runner-reported `chat:end`. The dispatcher calls it with three
 * arguments, so production always gets `RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS`;
 * the fourth exists so tests need not wait 30 s.
 */
export async function fireEventChatEnd(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
  subscriberTimeoutMs: number = RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS,
): Promise<void> {
  const result = await bus.fire('chat:end', ctx, payload, { subscriberTimeoutMs });
  if (result.rejected) {
    ctx.logger.warn('event_subscriber_rejected', {
      hook: 'chat:end',
      reason: result.reason,
    });
  }
}
