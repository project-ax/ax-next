import { PluginError } from '@ax/core';
import {
  SessionGetConfigRequestSchema,
  SessionGetConfigResponseSchema,
  type SessionGetConfigRequest,
  type SessionGetConfigResponse,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /session.get-config
//
// Runner-boot RPC. Calls the `session:get-config` service hook on the host
// bus; the session backend (postgres / inmemory) reads its OWN session row
// keyed by `ctx.sessionId` (set by the IPC server's auth gate after the
// bearer token resolves) and returns {userId, agentId, agentConfig}.
//
// The request body is `.strict({})`. There is intentionally NO sessionId
// in the body — the runner cannot ask for someone else's config because
// the server reads ctx, not the body. A future change that adds a
// "sessionId" body parameter would need a strong reason and a security
// review; the schema keeps that conversation visible.
//
// Reject paths:
//   - PluginError(unknown-session) → 404 SESSION_INVALID
//   - PluginError(owner-missing)   → 409 SESSION_INVALID  (legacy session
//     pre-9.5 with no v2 row; the runner has no agent config to use)
//   - any other PluginError        → mapPluginError defaults
// ---------------------------------------------------------------------------

export const sessionGetConfigHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = SessionGetConfigRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`session.get-config: ${parsed.error.message}`);
  }

  let result: SessionGetConfigResponse;
  try {
    result = await bus.call<SessionGetConfigRequest, SessionGetConfigResponse>(
      'session:get-config',
      ctx,
      parsed.data,
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.get-config', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = SessionGetConfigResponseSchema.safeParse(result);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'session.get-config',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
