import {
  PRE_CALL_REJECT_REASON_MAX,
  ToolPreCallRequestSchema,
  ToolPreCallResponseSchema,
  type ToolCall,
} from '@ax/ipc-protocol';
import { isHold } from '@ax/core';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /tool.pre-call
//
// Fires the `tool:pre-call` subscriber chain. Subscribers vote on whether the
// call proceeds:
//
//   - pass-through         → { verdict: 'allow', modifiedCall: <call> }
//   - modified             → { verdict: 'allow', modifiedCall: <modified> }
//   - vetoed (reject)      → { verdict: 'reject', reason }
//   - held (hold)          → { verdict: 'hold', decisionId, note }
//
// A `reject` is NOT a protocol error (not a 409) — it's a first-class answer:
// the pre-call hook's whole purpose is to vote, and "no" is an expected
// verdict. We always include `modifiedCall` on the allow path (cheap + the
// client needs it) rather than comparing input vs output deeply. `hold` is a
// `Rejection` subtype (see @ax/core's `Hold`) checked BEFORE the generic
// rejection branch so it isn't flattened into a plain deny.
// ---------------------------------------------------------------------------

/**
 * Truncate a deny reason to the wire ceiling. This handler is the only thing
 * that builds the `reject` arm, and any `tool:pre-call` subscriber can put any
 * string in `reason` — so the clamp lives here, not in each subscriber. Too
 * long becomes shorter, never a 500: a deny must still read as this deny.
 * Never cuts a surrogate pair in half (a lone surrogate is not valid UTF-8 and
 * gets mangled on the way out).
 */
function clampReason(reason: string): string {
  if (reason.length <= PRE_CALL_REJECT_REASON_MAX) return reason;
  let end = PRE_CALL_REJECT_REASON_MAX;
  const last = reason.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return reason.slice(0, end);
}

export const toolPreCallHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ToolPreCallRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`tool.pre-call: ${parsed.error.message}`);
  }

  const result = await bus.fire<ToolCall>('tool:pre-call', ctx, parsed.data.call);

  // A hold is a rejection subtype (see @ax/core's Hold). Check for it FIRST —
  // `result.rejected` is true for both, and the generic branch below would
  // otherwise flatten a hold into a deny, which is exactly the outcome `hold`
  // exists to avoid (a deny invites the model to route around it).
  if (isHold(result)) {
    const body = {
      verdict: 'hold' as const,
      decisionId: result.hold.decisionId,
      note: result.hold.note,
    };
    const checked = ToolPreCallResponseSchema.safeParse(body);
    if (!checked.success) {
      logInternalError(
        ctx.logger,
        'tool.pre-call',
        new Error(`response shape drift: ${checked.error.message}`),
      );
      return internalError();
    }
    return { status: 200, body: checked.data };
  }

  if (result.rejected) {
    const body = { verdict: 'reject' as const, reason: clampReason(result.reason) };
    const checked = ToolPreCallResponseSchema.safeParse(body);
    if (!checked.success) {
      logInternalError(
        ctx.logger,
        'tool.pre-call',
        new Error(`response shape drift: ${checked.error.message}`),
      );
      return internalError();
    }
    return { status: 200, body: checked.data };
  }

  const body = { verdict: 'allow' as const, modifiedCall: result.payload };
  const checked = ToolPreCallResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'tool.pre-call',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
