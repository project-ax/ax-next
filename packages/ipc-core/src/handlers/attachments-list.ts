import {
  AttachmentsListRequestSchema,
  AttachmentsListResponseSchema,
} from '@ax/ipc-protocol';
import { PluginError } from '@ax/core';
import { internalError, logInternalError, mapPluginError, validationError } from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /attachments.list — TASK-68, out-of-git Part C (inbound).
//
// At session start — and again on a warm-runner rebind that brings a new upload
// (TASK-78) — the runner enumerates the bound conversation's uploads so it can
// pull each blob (`blob.get`) and materialize the read-only working copy at the
// path advertised to the model. Each entry carries the workspace-relative `path`
// (`.ax/uploads/<conv>/<turn>/<file>`, which the runner materializes at
// `<workspaceRoot>/.ax/uploads/...`), the `sha256` that addresses the blob, and
// display metadata.
//
// Authz: the host-side `attachments:list-for-conversation` hook reads
// `ctx.userId` (the session bearer's user) and the requested conversationId, and
// returns the empty set for a conversation the user doesn't own — a foreign
// runner learns nothing about another user's uploads.
// ---------------------------------------------------------------------------

interface AttachmentsListForConversationInput {
  conversationId: string;
}
interface AttachmentsListForConversationOutput {
  files: Array<{
    path: string;
    sha256: string;
    mediaType: string;
    displayName: string;
    sizeBytes: number;
  }>;
}

export const attachmentsListHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = AttachmentsListRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`attachments.list: ${parsed.error.message}`);
  }
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
  const checked = AttachmentsListResponseSchema.safeParse(out);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'attachments.list',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
