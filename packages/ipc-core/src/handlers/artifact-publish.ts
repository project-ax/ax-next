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
import { REWRITES_THE_SURFACE } from '@ax/core/surface-text';
import { refuseUnboundConversation } from './bound-conversation.js';
import { sessionPutBlob } from './session-blob-puts.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /artifact.publish — the agent's `artifact_publish` tool.
//
// After the runner streams a file's bytes via `blob.put`, it posts this small
// envelope and the host's `artifacts:publish` hook adds a version to the
// agent's artifact: a new artifact, or the one already published from `path`
// (or named by `artifactId`). The bytes are already durable in the blob store
// at this point; this call records which artifact they are a version of.
//
// Gates, in order, each before the hook runs:
//   1. zod: the strict request shape (a warm runner from the old image that
//      still sends `displayName`/`mediaType`/`size` gets a 400).
//   2. `path` holds no control, format or bidi character. It is untrusted
//      model text the host stores and shows back to the agent and the person;
//      the class is the one `@ax/core/surface-text` owns.
//   3. `conversationId` is the conversation the session is bound to
//      (`refuseUnboundConversation`; `ctx.conversationId` comes from the bearer
//      token's session, never the body).
//   4. Only a sha THIS session's own `blob.put` returned (TASK-1010,
//      `session-blob-puts.ts`, tracked host-side). The store is shared and
//      content-addressed and a hash can leak into model-visible text, so a sha
//      is not proof the runner holds the bytes. Any other sha gets the SAME 404
//      the hook's own not-found maps to, decided before the hook runs, so the
//      answer says nothing about whether the sha exists.
//
// Then the hook decides the rest with the session's ctx as stamped by the
// listener: it writes as `ctx.userId`, refuses a conversation that user does
// not own, and refuses a conversation with another agent than `ctx.agentId`.
//
// The answer is the hook's {artifactId, version, title, kind, extension},
// re-checked against the wire schema. Never a share code (C1); the runner
// builds `ax://artifact/<id>` itself.
// ---------------------------------------------------------------------------

interface ArtifactsPublishInput {
  conversationId: string;
  sha256: string;
  sourcePath: string;
  title: string;
  artifactId?: string;
  /** A chat visual (the runner's show_visual): kept out of every Artifacts surface. */
  visual?: boolean;
}

// The one response for "not this session's blob" and "the blob is gone": the
// body `mapPluginError` gives the hook's own not-found.
const PUBLISH_NOT_FOUND = 'not found';

export const artifactPublishHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ArtifactPublishRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`artifact.publish: ${zodSummary(parsed.error)}`);
  }
  if (REWRITES_THE_SURFACE.test(parsed.data.path)) {
    return validationError('artifact.publish: path holds a control or invisible character');
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
  const { conversationId, sha256, path: sourcePath, title, artifactId, visual } = parsed.data;
  let out: unknown;
  try {
    out = await bus.call<ArtifactsPublishInput, unknown>('artifacts:publish', ctx, {
      conversationId,
      sha256,
      sourcePath,
      title,
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(visual === true ? { visual: true } : {}),
    });
  } catch (err) {
    // A PluginError from the hook (e.g. forbidden: foreign conversation) maps to
    // the right HTTP status; anything else is sanitized to 500. Log every 500
    // before returning it: the real bus wraps a plain throw (a DB outage) into
    // PluginError{code:'unknown'}, which maps to 500 too (TASK-1010).
    const mapped = err instanceof PluginError ? mapPluginError(err) : internalError();
    if (mapped.status >= 500) {
      logInternalError(ctx.logger, 'artifact.publish', err);
    } else if (err instanceof PluginError) {
      // An expected answer (e.g. a blob this session put but has since been
      // purged). Logged so it can be told apart from the guard's refusal above.
      ctx.logger.warn('artifact_publish_hook_refused', {
        action: 'artifact.publish',
        pluginErrorCode: err.code,
      });
    }
    return mapped;
  }
  const checked = ArtifactPublishResponseSchema.safeParse(out);
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
