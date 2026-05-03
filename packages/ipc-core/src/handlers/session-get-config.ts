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
// bearer token resolves) and returns {userId, agentId, agentConfig,
// conversationId}.
//
// Phase E (2026-05-09): if `conversationId` is non-null the handler ALSO
// calls `conversations:get-metadata` to pull `runnerSessionId` (the bound
// SDK session id) and folds it into the wire response. The runner uses
// that to pick `query({ resume })` vs a fresh SDK session — it's the
// reader replacement for the now-deleted `conversation.fetch-history`
// IPC. The composition lives in the handler (not in the session backend
// hook) so the bus-level `session:get-config` output stays
// session-backend-only — conversations vocabulary doesn't leak across
// the bus boundary into a backend that has no business with it (I4).
//
// The userId we pass to `conversations:get-metadata` comes from the
// `session:get-config` response — bound to ctx.sessionId via the bearer
// token. The runner cannot smuggle a different userId; the handler
// controls the argument.
//
// `conversations:get-metadata` throwing `not-found` is treated as
// runnerSessionId=null + log + continue. It's a defensive path: in
// practice the conversation row exists if the session row references it,
// but a race (delete-during-boot) shouldn't kill the entire session
// boot. No information leak — the runner already learned conversationId
// from the same response.
//
// The request body is `.strict({})`. There is intentionally NO sessionId
// in the body — the runner cannot ask for someone else's config because
// the server reads ctx, not the body. A future change that adds a
// "sessionId" body parameter would need a strong reason and a security
// review; the schema keeps that conversation visible.
//
// Reject paths:
//   - PluginError(unknown-session) → 401 SESSION_INVALID
//   - PluginError(owner-missing)   → 401 SESSION_INVALID  (legacy session
//     pre-9.5 with no v2 row; the runner has no agent config to use)
//   - any other PluginError from session:get-config → mapPluginError
//   - PluginError(not-found) from get-metadata → log + null runnerSessionId
//   - any other error from get-metadata → mapPluginError / 500
// ---------------------------------------------------------------------------

// Bus-level shapes for `session:get-config` and `conversations:get-metadata`.
// We don't import the structural types from those plugins (no cross-plugin
// imports in handler code — the bus is the contract). The fields we actually
// read are pinned here.
interface BusSessionGetConfigOutput {
  userId: string;
  agentId: string;
  agentConfig: SessionGetConfigResponse['agentConfig'];
  conversationId: string | null;
}

interface BusGetMetadataInput {
  conversationId: string;
  userId: string;
}

interface BusGetMetadataOutput {
  runnerSessionId: string | null;
}

export const sessionGetConfigHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = SessionGetConfigRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`session.get-config: ${parsed.error.message}`);
  }

  let cfg: BusSessionGetConfigOutput;
  try {
    cfg = await bus.call<SessionGetConfigRequest, BusSessionGetConfigOutput>(
      'session:get-config',
      ctx,
      parsed.data,
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.get-config', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  // Compose runnerSessionId from conversations:get-metadata when this
  // session is conversation-scoped. Non-conversation sessions
  // (conversationId === null) skip the metadata round-trip entirely.
  let runnerSessionId: string | null = null;
  if (cfg.conversationId !== null) {
    try {
      const md = await bus.call<BusGetMetadataInput, BusGetMetadataOutput>(
        'conversations:get-metadata',
        ctx,
        { conversationId: cfg.conversationId, userId: cfg.userId },
      );
      runnerSessionId = md.runnerSessionId;
    } catch (err) {
      // not-found: defensive log + null runnerSessionId. The session
      // row references a conversation that doesn't exist (delete race
      // or ACL drift). Continuing with a fresh SDK session is safer
      // than failing boot — no information leak (the runner already
      // knows conversationId from the response above).
      if (err instanceof PluginError && err.code === 'not-found') {
        logInternalError(ctx.logger, 'session.get-config', err);
        runnerSessionId = null;
      } else {
        logInternalError(ctx.logger, 'session.get-config', err);
        if (err instanceof PluginError) return mapPluginError(err);
        return internalError();
      }
    }
  }

  const composed: SessionGetConfigResponse = {
    userId: cfg.userId,
    agentId: cfg.agentId,
    agentConfig: cfg.agentConfig,
    conversationId: cfg.conversationId,
    runnerSessionId,
  };

  const checked = SessionGetConfigResponseSchema.safeParse(composed);
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
