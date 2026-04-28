import type { AgentContext, HookBus } from '@ax/core';
import { EventToolPostCallSchema } from '@ax/ipc-protocol';
import { validationError } from '../errors.js';
import type { HandlerErr } from './types.js';

// ---------------------------------------------------------------------------
// POST /event.tool-post-call
//
// Fire-and-forget observation event. Design D4: `tool:post-call` is
// OBSERVATION-ONLY — a subscriber rejection is logged but DOES NOT become a
// protocol error. The action already completed in the sandbox; we're just
// telling the host so audit-log / cache / etc. can react. If a subscriber
// said "no" here, the sandbox has no way to undo its call.
//
// Payload shape fired on the bus is `{ toolCall, output }` — matches the
// key names already used by chat-loop.ts in @ax/core, which is what
// audit-log's subscriber reads. DO NOT rename to `call` — that would break
// existing subscribers silently.
// ---------------------------------------------------------------------------

export function validateEventToolPostCall(rawPayload: unknown):
  | { ok: true; payload: { toolCall: unknown; output: unknown; durationMs?: number } }
  | HandlerErr {
  const parsed = EventToolPostCallSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`event.tool-post-call: ${parsed.error.message}`);
  }
  // Wire payload field is `call`; internal hook payload key is `toolCall`
  // (matches chat-loop.ts). Rename here so subscribers see the expected shape.
  const out: { toolCall: unknown; output: unknown; durationMs?: number } = {
    toolCall: parsed.data.call,
    output: parsed.data.output,
  };
  if (parsed.data.durationMs !== undefined) out.durationMs = parsed.data.durationMs;
  return { ok: true, payload: out };
}

export async function fireEventToolPostCall(
  ctx: AgentContext,
  bus: HookBus,
  payload: unknown,
): Promise<void> {
  const result = await bus.fire('tool:post-call', ctx, payload);
  if (result.rejected) {
    // Observation-only: subscribers can signal "I disagree" but we can't
    // act on it — the tool already ran. Log at info (not warn) because a
    // cache invalidation or policy subscriber returning reject is a normal
    // flow signal, not an error.
    ctx.logger.info('observation_only_hook_rejection_ignored', {
      hook: 'tool:post-call',
      reason: result.reason,
    });
  }
}
