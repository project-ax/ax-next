import {
  ToolPreCallRequestSchema,
  ToolPreCallResponseSchema,
  type ToolCall,
} from '@ax/ipc-protocol';
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
//
// A `reject` is NOT a protocol error (not a 409) — it's a first-class answer:
// the pre-call hook's whole purpose is to vote, and "no" is an expected
// verdict. We always include `modifiedCall` on the allow path (cheap + the
// client needs it) rather than comparing input vs output deeply.
// ---------------------------------------------------------------------------

export const toolPreCallHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ToolPreCallRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`tool.pre-call: ${parsed.error.message}`);
  }

  const result = await bus.fire<ToolCall>('tool:pre-call', ctx, parsed.data.call);

  if (result.rejected) {
    const body = { verdict: 'reject' as const, reason: result.reason };
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
