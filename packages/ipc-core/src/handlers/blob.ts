import type { AgentContext, HookBus } from '@ax/core';
import {
  BlobGetRequestSchema,
  BlobPutResponseSchema,
} from '@ax/ipc-protocol';
import { internalError, logInternalError, notFound, validationError } from '../errors.js';
import type { ActionHandler, HandlerResult } from './types.js';

// ---------------------------------------------------------------------------
// POST /blob.put  (REQUEST-direction binary) — TASK-68, out-of-git Part C.
//
// The runner-side artifact_publish executor streams an artifact's raw bytes
// here as an `application/octet-stream` body (no JSON envelope). The dispatcher
// reads the raw body (capped at the blob ceiling, NOT the 4 MiB MAX_FRAME) and
// hands us the Buffer; we forward it to the content-addressed `blob:put` service
// hook and return the small `{sha256,size}` JSON envelope.
//
// This is the FIRST runner-side caller of `blob:put` (TASK-65 deferred it). The
// bytes are opaque (content-addressed; never interpreted). The sha is computed
// by the store, not the caller — a malicious runner can't forge a content
// address. blob.put is idempotent (identical bytes ⇒ same sha, one object).
//
// `blob.put` does NOT carry a conversationId or any ownership scope — it's a
// pure content-addressed write. The METADATA row (which conversation owns this
// blob) is inserted separately by `artifact.publish` / the host-side
// attachments path, so a blob with no referencing row is just an orphan a GC
// sweep reclaims (design open-question #3). The bytes alone leak nothing (you
// can't read a blob back without knowing its sha, and you only learn the sha if
// you stored it).
// ---------------------------------------------------------------------------

export type BinaryActionHandler = (
  body: Buffer,
  ctx: AgentContext,
  bus: HookBus,
) => Promise<HandlerResult>;

interface BlobPutInput {
  bytes: Uint8Array;
}
interface BlobPutOutput {
  sha256: string;
  size: number;
}

export const blobPutHandler: BinaryActionHandler = async (body, ctx, bus) => {
  let out: BlobPutOutput;
  try {
    out = await bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    });
  } catch (err) {
    logInternalError(ctx.logger, 'blob.put', err);
    return internalError();
  }
  const checked = BlobPutResponseSchema.safeParse(out);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'blob.put',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};

// ---------------------------------------------------------------------------
// POST /blob.get  (response-direction binary) — TASK-68.
//
// JSON request `{sha256}` → raw octet-stream response body (the blob bytes,
// streamed to a temp file on the runner via callBinary). Used at session start
// to materialize `/ephemeral/uploads` from the store. The sha is wire-validated
// (`^[a-f0-9]{64}$`) so a malformed key can't reach the filesystem shard; the
// store re-validates with the identical regex AND re-verifies the digest on read
// (TASK-65). A missing blob → 404 (not a 500 — it's an expected outcome when a
// referenced object was GC'd or never landed).
// ---------------------------------------------------------------------------

interface BlobGetInput {
  sha256: string;
}
type BlobGetOutput = { bytes: Uint8Array } | { found: false };

export const blobGetHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = BlobGetRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`blob.get: ${parsed.error.message}`);
  }
  let out: BlobGetOutput;
  try {
    out = await bus.call<BlobGetInput, BlobGetOutput>('blob:get', ctx, {
      sha256: parsed.data.sha256,
    });
  } catch (err) {
    logInternalError(ctx.logger, 'blob.get', err);
    return internalError();
  }
  if ('found' in out && out.found === false) {
    return notFound('blob not found');
  }
  const bytes = (out as { bytes: Uint8Array }).bytes;
  return {
    status: 200,
    binary: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    contentType: 'application/octet-stream',
  };
};
