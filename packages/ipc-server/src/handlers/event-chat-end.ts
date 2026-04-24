import type { ChatContext, HookBus } from '@ax/core';
import { EventChatEndSchema, type EventChatEnd } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.chat-end
//
// Fire-and-forget. The `chat:end` hook is what @ax/audit-log listens to for
// durable persistence of chat outcomes — any change to the payload shape here
// breaks audit-log silently. The wire shape is `{ outcome: ChatOutcome }`
// and the hook fires with the same key name, matching chat-loop.ts.
// ---------------------------------------------------------------------------

export function validateEventChatEnd(rawPayload: unknown):
  | { ok: true; payload: EventChatEnd }
  | HandlerErr {
  const parsed = EventChatEndSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.chat-end: ${parsed.error.message}`);
  }
  return { ok: true, payload: parsed.data };
}

export async function fireEventChatEnd(
  ctx: ChatContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const result = await bus.fire('chat:end', ctx, payload);
  if (result.rejected) {
    ctx.logger.warn('event_subscriber_rejected', {
      hook: 'chat:end',
      reason: result.reason,
    });
  }
}
