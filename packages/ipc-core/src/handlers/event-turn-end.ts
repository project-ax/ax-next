import type { AgentContext, HookBus } from '@ax/core';
import { EventTurnEndSchema, type EventTurnEnd } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.turn-end
//
// Fire-and-forget. Fires `chat:turn-end` subscribers with the parsed event
// payload. `chat:turn-end` is a new subscriber hook introduced by the 6.5a
// topology — no existing subscribers yet; @ax/audit-log picks it up in a
// later task. Rejection is logged at warn (this IS an actionable signal
// for the host — a subscriber rejecting a turn-end could mean cleanup
// didn't happen) but never echoed back to the sandbox.
// ---------------------------------------------------------------------------

export function validateEventTurnEnd(rawPayload: unknown):
  | { ok: true; payload: EventTurnEnd }
  | HandlerErr {
  const parsed = EventTurnEndSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.turn-end: ${parsed.error.message}`);
  }
  return { ok: true, payload: parsed.data };
}

export async function fireEventTurnEnd(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const result = await bus.fire('chat:turn-end', ctx, payload);
  if (result.rejected) {
    ctx.logger.warn('event_subscriber_rejected', {
      hook: 'chat:turn-end',
      reason: result.reason,
    });
  }
}
