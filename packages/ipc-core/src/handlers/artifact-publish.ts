import {
  ArtifactPublishRequestSchema,
  ArtifactPublishResponseSchema,
} from '@ax/ipc-protocol';
import {
  zodSummary,
  internalError,
  logInternalError,
  mapPluginError,
  notFound,
  validationError,
} from '../errors.js';
import { PluginError } from '@ax/core';
import { refuseUnboundConversation } from './bound-conversation.js';
import { sessionPutBlob } from './session-blob-puts.js';
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
// What gets published (TASK-1010): only a sha THIS session's own `blob.put`
// returned (`session-blob-puts.ts`, tracked host-side; the runner never
// supplies the set). The store is shared and content-addressed, and a hash can
// leak into model-visible text, so a sha is not proof the runner holds the
// bytes. Without this check a raw-IPC runner could publish another user's blob
// into its own conversation (whose owner then downloads it via `/api/files`),
// and could tell from 404 vs 200 whether any hash is stored. Any other sha gets
// the SAME 404 the hook's own not-found maps to (a blob put here and since
// purged), decided before the hook runs, so the answer says nothing about
// whether the sha exists.
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

// The one response for "not this session's blob" and "the blob is gone": the
// body `mapPluginError` gives the hook's own not-found.
const PUBLISH_NOT_FOUND = 'not found';

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
  if (!sessionPutBlob(ctx, parsed.data.sha256)) {
    // Host-side only; the sha (the would-be capability) stays out of the log.
    ctx.logger.warn('artifact_publish_unput_sha_refused', { action: 'artifact.publish' });
    return notFound(PUBLISH_NOT_FOUND);
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
    // the right HTTP status; anything else is sanitized to 500. Log every 500
    // before returning it: the real bus wraps a plain throw (a DB outage) into
    // PluginError{code:'unknown'}, which maps to 500 too (TASK-1010).
    const mapped = err instanceof PluginError ? mapPluginError(err) : internalError();
    if (mapped.status >= 500) logInternalError(ctx.logger, 'artifact.publish', err);
    return mapped;
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
