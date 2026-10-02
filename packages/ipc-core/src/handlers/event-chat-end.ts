import { randomUUID } from 'node:crypto';
import type { AgentContext, HookBus } from '@ax/core';
import { EventChatEndSchema, type EventChatEnd } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import { appendSaveRefusedBestEffort } from './event-turn-end.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.chat-end
//
// Fire-and-forget. The `chat:end` hook is what @ax/audit-log listens to for
// durable persistence of chat outcomes — any change to the payload shape here
// breaks audit-log silently. The wire shape is `{ outcome: AgentOutcome }`
// and the hook fires with the same key name, matching chat-loop.ts.
//
// TASK-731 added an OPTIONAL `saveRefused` (a refused final/idle save). It is
// persisted by `persistEventChatEnd` before the fire; subscribers that only
// read `outcome` see no change.
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
 * TASK-731 — persist a refused FINAL/idle save before `chat:end` fires (the
 * dispatcher's `persist` slot, awaited before the 202).
 *
 * The final flush runs after the last turn-end, so there is no turn-end to
 * carry its refusal and no stream open to show it. It bundles everything
 * since the baseline, which can include files from earlier replies whose own
 * save came back `kept`, so the person may have seen those files being made.
 * We write a `save-refused` display event and the next read of the thread
 * shows it.
 *
 * The key is minted HERE, on the host (`final:<uuid>`), never taken from the
 * runner: each final refusal is its own row, and nothing the runner sends can
 * fold it onto (and so overwrite) another row. Best-effort: the helper logs
 * and swallows, so this never throws and the chat-end ack and the `chat:end`
 * that resolves the waiting turn are unaffected. With no `saveRefused` (the
 * common case) it returns at once, so chat-end's ack gains no latency.
 */
export async function persistEventChatEnd(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const code = (payload as Partial<EventChatEnd>).saveRefused;
  if (code === undefined) return;
  await appendSaveRefusedBestEffort(
    ctx,
    bus,
    code,
    FINAL_SAVE_REFUSED_KEY_PREFIX + randomUUID(),
  );
}

/**
 * Prefix of the fold key for a final/idle `save-refused` row (TASK-731). Built
 * by concatenation, not a template literal: the dependency-sync test reads a
 * template literal that opens with a colon-segmented word as a dynamic HOOK
 * name, and this is a row key, not a hook.
 */
const FINAL_SAVE_REFUSED_KEY_PREFIX = 'final:';

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
