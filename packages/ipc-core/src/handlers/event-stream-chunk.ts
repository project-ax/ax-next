import type { AgentContext, HookBus } from '@ax/core';
import { EventStreamChunkSchema, type EventStreamChunk } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.stream-chunk
//
// Fire-and-forget. Fires `chat:stream-chunk` subscribers with the parsed
// event payload. The handler MUST NOT reshape — subscribers see the exact
// EventStreamChunkSchema shape `{ reqId, text, kind }`. Subscribers filter
// by `reqId` themselves (a single host serves multiple in-flight chats and
// the SSE consumer in Task 7 needs to pick out its own stream).
//
// `text` is UNTRUSTED model output: subscribers are responsible for treating
// it as such (no interpolation into HTML/SQL/shell). The handler does not
// inspect or sanitize the text.
// ---------------------------------------------------------------------------

export function validateEventStreamChunk(rawPayload: unknown):
  | { ok: true; payload: EventStreamChunk }
  | HandlerErr {
  const parsed = EventStreamChunkSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.stream-chunk: ${parsed.error.message}`);
  }
  return { ok: true, payload: parsed.data };
}

export async function fireEventStreamChunk(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const result = await bus.fire('chat:stream-chunk', ctx, payload);
  if (result.rejected) {
    // Observation-only: a subscriber rejecting a stream chunk does not
    // unwind the chunk (the runner already sent it). Log at info — a
    // policy/cache subscriber returning reject is a normal flow signal,
    // not an error.
    ctx.logger.info('observation_only_hook_rejection_ignored', {
      hook: 'chat:stream-chunk',
      reason: result.reason,
    });
  }
}
