import {
  ArtifactPublishRequestSchema,
  ArtifactPublishResponseSchema,
} from '@ax/ipc-protocol';
import { internalError, logInternalError, mapPluginError, validationError } from '../errors.js';
import { PluginError } from '@ax/core';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /artifact.publish — TASK-68, out-of-git Part C (outbound).
//
// After the runner streams an artifact's bytes via `blob.put`, it posts this
// small metadata envelope so the host inserts the artifact row and mints the
// stable `ax://artifact/<id>` URL. The bytes are already durable in the blob
// store at this point — this call only records WHO owns them and HOW to display
// them. Durability is observable at the runner's `blob.put` return, not here.
//
// Authz: the host-side `artifacts:publish-blob` hook reads `ctx.userId` (the
// session bearer's user, resolved by the IPC server before dispatch) and scopes
// the insert to it, so a runner can't publish into another user's conversation.
// `conversationId` is supplied by the runner (its bound conversation) and the
// hook re-checks ownership.
//
// `displayName`/`mediaType` are UNTRUSTED model-supplied text — stored verbatim,
// never shell-interpolated; the renderer treats them as untrusted (the download
// route already sanitizes Content-Disposition + sends nosniff).
// ---------------------------------------------------------------------------

interface ArtifactPublishBlobInput {
  conversationId: string;
  sha256: string;
  path: string;
  displayName: string;
  mediaType: string;
  size: number;
}
interface ArtifactPublishBlobOutput {
  artifactId: string;
}

export const artifactPublishHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ArtifactPublishRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`artifact.publish: ${parsed.error.message}`);
  }
  let out: ArtifactPublishBlobOutput;
  try {
    out = await bus.call<ArtifactPublishBlobInput, ArtifactPublishBlobOutput>(
      'artifacts:publish-blob',
      ctx,
      {
        conversationId: parsed.data.conversationId,
        sha256: parsed.data.sha256,
        path: parsed.data.path,
        displayName: parsed.data.displayName,
        mediaType: parsed.data.mediaType,
        size: parsed.data.size,
      },
    );
  } catch (err) {
    // A PluginError from the hook (e.g. forbidden: foreign conversation) maps to
    // the right HTTP status; anything else is sanitized to 500.
    if (err instanceof PluginError) {
      return mapPluginError(err);
    }
    logInternalError(ctx.logger, 'artifact.publish', err);
    return internalError();
  }
  const body = {
    artifactId: out.artifactId,
    downloadUrl: `ax://artifact/${out.artifactId}`,
  };
  const checked = ArtifactPublishResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'artifact.publish',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
