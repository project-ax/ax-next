import {
  AttachmentsListRequestSchema,
  AttachmentsListResponseSchema,
} from '@ax/ipc-protocol';
import { PluginError } from '@ax/core';
import { zodSummary, internalError, logInternalError, mapPluginError, validationError } from '../errors.js';
import { refuseUnboundConversation } from './bound-conversation.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /attachments.list — TASK-68, out-of-git Part C (inbound).
//
// At session start — and again when a later message brings an upload the
// runner has not seen — the runner enumerates its conversation's uploads so it
// can pull each blob (`blob.get`) and keep a working copy inside the sandbox.
// Each entry carries the `attachmentId` the transcript's `attachment` block
// names, the `sha256` that addresses the blob, and display metadata. No path:
// where the copy lands is the runner's business.
//
// Authz, two layers:
//   1. Here: the requested conversation must be the one the session is bound
//      to (`refuseUnboundConversation`). A runner cannot list another
//      conversation, not even another one of the same person's.
//   2. The host-side `attachments:list-for-conversation` hook returns only rows
//      owned by `ctx.userId`.
// ---------------------------------------------------------------------------

interface AttachmentsListForConversationInput {
  conversationId: string;
}
interface AttachmentsListForConversationOutput {
  files: Array<{
    attachmentId: string;
    filename: string;
    sha256: string;
    mediaType: string;
    sizeBytes: number;
  }>;
}

export const attachmentsListHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = AttachmentsListRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`attachments.list: ${zodSummary(parsed.error)}`);
  }
  const refused = refuseUnboundConversation(
    ctx,
    parsed.data.conversationId,
    'attachments.list',
    'attachments_list_foreign_conversation_refused',
  );
  if (refused !== null) return refused;
  let out: AttachmentsListForConversationOutput;
  try {
    out = await bus.call<
      AttachmentsListForConversationInput,
      AttachmentsListForConversationOutput
    >('attachments:list-for-conversation', ctx, {
      conversationId: parsed.data.conversationId,
    });
  } catch (err) {
    if (err instanceof PluginError) {
      return mapPluginError(err);
    }
    logInternalError(ctx.logger, 'attachments.list', err);
    return internalError();
  }
  // Re-check the host's answer against the wire schema before it reaches the
  // runner, which names files after these entries.
  const checked = AttachmentsListResponseSchema.safeParse(out);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'attachments.list',
      new Error(`response shape drift: ${zodSummary(checked.error)}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
