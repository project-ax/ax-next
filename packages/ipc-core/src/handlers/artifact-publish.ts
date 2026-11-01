import {
  ArtifactPublishRequestSchema,
  ArtifactPublishResponseSchema,
} from '@ax/ipc-protocol';
import { zodSummary, internalError, logInternalError, mapPluginError, validationError } from '../errors.js';
import { PluginError } from '@ax/core';
import { refuseUnboundConversation } from './bound-conversation.js';
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
// Authz, two layers. A download resolves an artifact by its id AND the row's
// conversation, so where a row lands decides who can read it:
//   1. Here: `conversationId` must be the conversation the session is bound to
//      (`refuseUnboundConversation`; `ctx.conversationId` comes from the bearer
//      token's session, never the body). A runner cannot record a row in any
//      other conversation.
//   2. The host-side `artifacts:publish-blob` hook writes the row as
//      `ctx.userId` (the session bearer's user), refuses a conversation that
//      user does not own, and never lets one user's publish take over another
//      user's row.
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
    return validationError(`artifact.publish: ${zodSummary(parsed.error)}`);
  }
  const refused = refuseUnboundConversation(
    ctx,
    parsed.data.conversationId,
    'artifact.publish',
    'artifact_publish_foreign_conversation_refused',
  );
  if (refused !== null) return refused;
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
      new Error(`response shape drift: ${zodSummary(checked.error)}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
