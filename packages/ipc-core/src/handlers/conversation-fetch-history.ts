import { PluginError } from '@ax/core';
import {
  ConversationFetchHistoryRequestSchema,
  ConversationFetchHistoryResponseSchema,
  type ConversationFetchHistoryResponse,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /conversation.fetch-history
//
// Runner-boot RPC for resume (Task 15 of Week 10–12, J3 + J6). Calls the
// `conversations:fetch-history` service hook on the host bus; the hook
// implementation lives in @ax/conversations and reuses the same
// `(user_id + agents:resolve)` ACL gate as `conversations:get`.
//
// Authz pattern (security review):
//
//   1. The IPC server's auth gate already resolved the runner's bearer
//      token to ctx.userId (Week 9.5; ipc-server/listener.ts).
//   2. The runner sends `{ conversationId }` in the body.
//   3. We pass ctx.userId straight to the service hook — the runner
//      cannot lie about its userId because it doesn't choose it; the
//      session token resolution did. So even if a malicious runner sent
//      a foreign conversationId, the host-side gate sees the runner's
//      OWN userId on the call and rejects with `not-found` if the row
//      doesn't belong to that user.
//   4. The runner ALSO knows its own conversationId (it learns it from
//      `session.get-config`'s extension) so a benign runner sends the
//      one bound to its session. We don't pre-validate against that
//      here because the gate above already enforces ownership; a
//      defensive double-check would only buy us a slightly tidier
//      error code (404 instead of 404).
//
// PluginError mapping mirrors session-get-config.ts:
//   - `not-found` → 404 NOT_FOUND  (mapPluginError defaults)
//   - `forbidden` → 403 HOOK_REJECTED
//   - `invalid-payload` → 400 VALIDATION
//   - everything else → mapPluginError defaults (typically 500)
// ---------------------------------------------------------------------------

export const conversationFetchHistoryHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = ConversationFetchHistoryRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`conversation.fetch-history: ${parsed.error.message}`);
  }

  let result: ConversationFetchHistoryResponse;
  try {
    // ctx.userId is set by the IPC server's auth gate from the session
    // token resolution. Passing it explicitly into the input keeps the
    // hook's existing shape intact (the conversations:get gate also
    // takes userId in input — same pattern, same audit trail).
    result = await bus.call<
      { conversationId: string; userId: string },
      ConversationFetchHistoryResponse
    >('conversations:fetch-history', ctx, {
      conversationId: parsed.data.conversationId,
      userId: ctx.userId,
    });
  } catch (err) {
    logInternalError(ctx.logger, 'conversation.fetch-history', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  // Defense-in-depth: re-parse the response shape before sending. A
  // future change to the conversations service hook that drifts the
  // wire shape would surface here as an internal error rather than as
  // an invalid wire frame downstream.
  const checked = ConversationFetchHistoryResponseSchema.safeParse(result);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'conversation.fetch-history',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
