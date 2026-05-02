import { PluginError } from '@ax/core';
import {
  ConversationStoreRunnerSessionRequestSchema,
  ConversationStoreRunnerSessionResponseSchema,
  type ConversationStoreRunnerSessionResponse,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /conversation.store-runner-session
//
// Phase C runner-owned sessions: mints the binding from the runner's native
// session_id (the SDK-level resumable handle the runner just observed in its
// `system/init` event) to the conversation row that owns the chat. The
// host will use this id later to ask the SDK to resume the in-runner
// session instead of replaying turns from the host DB.
//
// Authz pattern (mirrors conversation.fetch-history, but the gate lives
// strictly on the bus impl side):
//
//   1. The IPC server's auth gate already resolved the runner's bearer
//      token to ctx.userId (Week 9.5; ipc-server/listener.ts).
//   2. The runner sends `{ conversationId, runnerSessionId }` in the body
//      (request schema is .strict — extra fields fail 400 here, before
//      the bus is touched, so a malicious runner can't smuggle a foreign
//      userId).
//   3. We pass `parsed.data` straight through to the service hook. Unlike
//      conversations:fetch-history (whose impl explicitly accepts userId
//      in input), conversations:store-runner-session reads `ctx.userId`
//      directly inside `storeRunnerSession()` — so we deliberately do NOT
//      add userId to the input. Adding it would be noise the bus ignores.
//   4. The bus impl runs a userId-scoped UPDATE: a runner whose ctx.userId
//      doesn't own `conversationId` will see `not-found`, never the row.
//      No `agents:resolve` round-trip — the orchestrator already gated the
//      user at agent:invoke entry (Phase B posture).
//
// PluginError mapping (via mapPluginError):
//   - `invalid-payload` → 400 VALIDATION
//   - `not-found`       → 404 NOT_FOUND  (cross-tenant or unknown row)
//   - `conflict`        → 409 HOOK_REJECTED  (different runnerSessionId
//                                            already bound to this row)
//   - everything else   → 500 INTERNAL
//
// On success the bus returns void; we shape the wire response as
// `{ ok: true }` and re-parse it through the response schema for
// shape-drift defense (mirrors conversation-fetch-history).
// ---------------------------------------------------------------------------

export const conversationStoreRunnerSessionHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = ConversationStoreRunnerSessionRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(
      `conversation.store-runner-session: ${parsed.error.message}`,
    );
  }

  try {
    // The bus impl reads ctx.userId itself; we must NOT smuggle userId
    // into input here. Passing parsed.data directly keeps the boundary
    // honest — input fields are exactly what the .strict schema let
    // through.
    await bus.call<
      { conversationId: string; runnerSessionId: string },
      void
    >('conversations:store-runner-session', ctx, parsed.data);
  } catch (err) {
    logInternalError(ctx.logger, 'conversation.store-runner-session', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  // Defense-in-depth: re-parse the literal response shape before
  // sending. If a future change to the response schema drifts the wire
  // shape, this surfaces as an internal error here rather than as an
  // invalid frame downstream.
  const checked = ConversationStoreRunnerSessionResponseSchema.safeParse({
    ok: true,
  });
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'conversation.store-runner-session',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return {
    status: 200,
    body: checked.data satisfies ConversationStoreRunnerSessionResponse,
  };
};
