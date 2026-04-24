import { PluginError } from '@ax/core';
import {
  LlmCallRequestSchema,
  LlmCallResponseSchema,
  type LlmCallRequest,
  type LlmCallResponse,
} from '@ax/ipc-protocol';
import {
  hookRejected,
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /llm.call
//
// Hook pipeline:
//   fire('llm:pre-call')  →  transform, may reject
//   call('llm:call')      →  actual provider
//   fire('llm:post-call') →  observe, may reject
//
// A reject from either subscriber is the expected veto path and surfaces as
// 409 HOOK_REJECTED (not 500). A thrown PluginError from the provider is
// bucketed by mapPluginError — sanitized message to the client, real
// details to the logger (I9 / no info leak).
//
// Zod-validates the response shape as defense-in-depth — if a provider
// plugin accidentally regresses its output, we want that to fail here
// rather than confuse the sandbox-side decoder.
// ---------------------------------------------------------------------------

export const llmCallHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = LlmCallRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`llm.call: ${parsed.error.message}`);
  }

  const pre = await bus.fire<LlmCallRequest>('llm:pre-call', ctx, parsed.data);
  if (pre.rejected) {
    return hookRejected(`llm:pre-call: ${pre.reason}`);
  }

  let response: LlmCallResponse;
  try {
    response = await bus.call<LlmCallRequest, LlmCallResponse>('llm:call', ctx, pre.payload);
  } catch (err) {
    logInternalError(ctx.logger, 'llm.call', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const post = await bus.fire<LlmCallResponse>('llm:post-call', ctx, response);
  if (post.rejected) {
    return hookRejected(`llm:post-call: ${post.reason}`);
  }

  const checked = LlmCallResponseSchema.safeParse(post.payload);
  if (!checked.success) {
    // Defense-in-depth: a subscriber or the provider plugin returned a shape
    // that doesn't match the wire schema. Log the detail, return sanitized.
    logInternalError(ctx.logger, 'llm.call', new Error(`response shape drift: ${checked.error.message}`));
    return internalError();
  }

  return { status: 200, body: checked.data };
};
