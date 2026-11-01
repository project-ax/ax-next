import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import {
  AttachmentsListResponseSchema,
  BlobGetRequestSchema,
  BlobPutResponseSchema,
} from '@ax/ipc-protocol';
import { zodSummary,
  hookRejected,
  internalError,
  logInternalError,
  notFound,
  validationError,
} from '../errors.js';
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
// sweep reclaims (design open-question #3; no such sweep exists yet, so orphans
// stay). An orphan is unreadable over IPC: `blob.get` below serves only a blob
// the session's own conversation references (TASK-1009), so knowing a sha is
// not enough to read it back.
//
// STORAGE LIMIT (TASK-690). Unowned in the store does NOT mean free: `blob:put`
// is a facade that fires the veto `blob:pre-put`, and the session's
// `ctx.userId` (the invoking person) is who @ax/disk-quota charges. A runner
// looping on this action with no matching `artifact.publish` row is exactly the
// fill-the-disk shape the limit exists for. A refusal comes back as 409
// HOOK_REJECTED with a reason the agent can pass on, instead of a bare 500:
// the subscriber's own sentence, except for a full disk, which gets
// BLOB_PUT_STORAGE_FULL_FOR_AGENT (TASK-993).
// ---------------------------------------------------------------------------

// Binary actions receive the raw REQUEST body PLUS the parsed request URL, so
// a handler can read query params alongside the octet-stream body (the
// REQUEST-direction binary channel carries no JSON envelope to put them in).
// Most binary handlers ignore the url; `session.append-transcript` reads its
// `fromSeq`/`prefixHash` from it. Mirrors `sessionNextMessageHandler`, the
// other url-aware handler.
export type BinaryActionHandler = (
  body: Buffer,
  ctx: AgentContext,
  bus: HookBus,
  url: URL,
) => Promise<HandlerResult>;

interface BlobPutInput {
  bytes: Uint8Array;
}
interface BlobPutOutput {
  sha256: string;
  size: number;
}

/**
 * What the agent is told when a file it is saving is refused because the
 * person's storage is full. Addressed to the model: it must not decide on its
 * own which of the person's files to delete to make room.
 */
export const BLOB_PUT_STORAGE_FULL_FOR_AGENT =
  "blob.put: the file was not saved because the person's storage is full. " +
  'Do not delete or move any files on your own to make room. Tell the person: ' +
  'they can ask you to clean up specific files they no longer need, or ask an admin for more room.';

export const blobPutHandler: BinaryActionHandler = async (
  body,
  ctx,
  bus,
  _url,
) => {
  let out: BlobPutOutput;
  try {
    out = await bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    });
  } catch (err) {
    // A `blob:pre-put` veto (a storage limit, TASK-690) is an answer, not a
    // fault: hand the runner a reason so the agent can tell the person.
    // Everything else stays a sanitized 500.
    if (err instanceof PluginError && err.code === 'rejected') {
      ctx.logger.warn('blob_put_refused', {
        action: 'blob.put',
        reason: err.message,
        ...(err.reasonCode !== undefined ? { reasonCode: err.reasonCode } : {}),
      });
      // A FULL disk gets a fixed, agent-addressed sentence (TASK-993) instead
      // of the person-facing one, which says "ask your agent to clean up
      // files". Read by the model, that is an instruction to itself to delete
      // the person's files and retry, with nobody there to say which (a
      // routine run). Any other policy refusal still passes its own reason.
      return hookRejected(
        err.reasonCode === 'storage-full' ? BLOB_PUT_STORAGE_FULL_FOR_AGENT : err.message,
      );
    }
    logInternalError(ctx.logger, 'blob.put', err);
    return internalError();
  }
  const checked = BlobPutResponseSchema.safeParse(out);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'blob.put',
      new Error(`response shape drift: ${zodSummary(checked.error)}`),
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
// to copy the conversation's uploads into the runner's scratch uploads
// directory. The sha is wire-validated
// (`^[a-f0-9]{64}$`) so a malformed key can't reach the filesystem shard; the
// store re-validates with the identical regex AND re-verifies the digest on read
// (TASK-65). A missing blob → 404 (not a 500 — it's an expected outcome when a
// referenced object was GC'd or never landed).
//
// SCOPE (TASK-1009). A content hash is not a capability. The store is shared
// and content-addressed, so without a scope check any runner that learned a
// hash (say, one that leaked into model-visible text) could read that blob,
// whoever it belongs to. So the handler serves only a blob the session's own
// conversation references: the sha must be one of the uploads
// `attachments:list-for-conversation` returns for `ctx.conversationId` — the
// conversation the listener stamped from the bearer token, never from the
// request — and that hook already scopes to `ctx.userId`. This is exactly the
// set `attachments.list` hands the runner, which is the only place its only
// caller (upload materialization) gets shas from.
//
// Everything else is the SAME 404 a missing blob gets: an unreferenced sha, a
// session bound to no conversation, and a deployment with no uploads store. So
// the response is no oracle for whether some other conversation's blob exists.
// The refusal is decided before the store is touched. A failed or malformed
// uploads lookup is a sanitized 500, never the bytes.
//
// Artifacts are deliberately out of scope: the runner writes them with
// `blob.put` and never reads one back over this action. A future runner
// reader adds its own reference set here, not a bypass.
// ---------------------------------------------------------------------------

interface BlobGetInput {
  sha256: string;
}
type BlobGetOutput = { bytes: Uint8Array } | { found: false };

const LIST_FOR_CONVERSATION_HOOK = 'attachments:list-for-conversation';

// The one response for "you may not have it" and "it does not exist".
const BLOB_NOT_FOUND = 'blob not found';

/**
 * Does the session's own conversation reference `sha256`? `false` covers every
 * "no" (unbound session, no uploads store, sha not listed); a lookup that
 * fails or answers out of shape throws, and the caller sanitizes it.
 */
async function sessionReferencesBlob(
  ctx: AgentContext,
  bus: HookBus,
  sha256: string,
): Promise<boolean> {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined || conversationId.length === 0) return false;
  if (!bus.hasService(LIST_FOR_CONVERSATION_HOOK)) return false;
  const listed = await bus.call<{ conversationId: string }, unknown>(
    LIST_FOR_CONVERSATION_HOOK,
    ctx,
    { conversationId },
  );
  const checked = AttachmentsListResponseSchema.safeParse(listed);
  if (!checked.success) {
    throw new Error(`uploads lookup shape drift: ${zodSummary(checked.error)}`);
  }
  return checked.data.files.some((f) => f.sha256 === sha256);
}

export const blobGetHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = BlobGetRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`blob.get: ${zodSummary(parsed.error)}`);
  }
  let referenced: boolean;
  try {
    referenced = await sessionReferencesBlob(ctx, bus, parsed.data.sha256);
  } catch (err) {
    logInternalError(ctx.logger, 'blob.get', err);
    return internalError();
  }
  if (!referenced) {
    // Host-side only: the runner sees the plain not-found below. The sha is
    // left out of the log (it is the would-be capability).
    ctx.logger.warn('blob_get_unreferenced_refused', {
      action: 'blob.get',
      sessionBoundToConversation:
        ctx.conversationId !== undefined && ctx.conversationId.length > 0,
    });
    return notFound(BLOB_NOT_FOUND);
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
    return notFound(BLOB_NOT_FOUND);
  }
  const bytes = (out as { bytes: Uint8Array }).bytes;
  return {
    status: 200,
    binary: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    contentType: 'application/octet-stream',
  };
};
