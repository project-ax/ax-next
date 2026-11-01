/**
 * @ax/attachments public types.
 *
 * Per Invariant I1, no field name encodes a particular backend (no `pg_`,
 * `bucket_`, `lfs_oid`, `sha`, etc.). The canonical alternate impl we keep
 * in mind is a future `@ax/attachments-pg-bytea-only` (i.e., no LFS — pure
 * Postgres) that would register the same hooks with the same shapes.
 */

import { z, type ZodType } from 'zod';
import { AttachmentIdSchema } from '@ax/ipc-protocol';

// Service hook payloads.

export interface StoreTempInput {
  bytes: Buffer;
  displayName: string;
  mediaType: string;
}

export interface StoreTempOutput {
  attachmentId: string;
  sizeBytes: number;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

export interface CommitInput {
  attachmentId: string;
  conversationId: string;
}

/**
 * What a committed upload is, as the transcript's `attachment` block carries
 * it: the same `attachmentId` the upload was staged under, plus display
 * metadata. No path — downloads and the runner's copy both address it by id.
 */
export interface CommitOutput {
  attachmentId: string;
  /** The name the person uploaded it under. Display text, never a path. */
  filename: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
}

export interface DownloadInput {
  /** An upload's or a published artifact's id. */
  attachmentId: string;
  /** The conversation being read; the row must belong to it. */
  conversationId: string;
  /**
   * Caller-supplied userId. Must equal ctx.userId, and the hook re-validates it
   * against `conversations:get({ conversationId, userId })` — the conversation
   * gate is the load-bearing ACL.
   */
  userId: string;
}

export interface DownloadOutput {
  bytes: Buffer;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}

// TASK-68 (out-of-git Part C): host-side metadata hooks.

/**
 * `artifacts:publish-blob` — the IPC `artifact.publish` action calls this after
 * the runner streamed the artifact bytes to `blob:put`. Inserts the artifact
 * metadata row scoped to ctx.userId, into a conversation ctx.userId owns;
 * returns the stable artifactId the chat chip and the download use. `path` is
 * the row's re-publish key and never leaves this plugin.
 *
 * The hook does not check who put `sha256`; a caller must pass a sha it put
 * itself (ipc-core enforces that for runners, TASK-1010).
 */
export interface ArtifactsPublishBlobInput {
  conversationId: string;
  sha256: string;
  path: string;
  displayName: string;
  mediaType: string;
  size: number;
}
export interface ArtifactsPublishBlobOutput {
  artifactId: string;
}

/**
 * `attachments:list-for-conversation` — the IPC `attachments.list` action calls
 * this when a runner starts (and when a later message brings an upload it has
 * not seen). Returns the conversation's committed uploads, owned by ctx.userId,
 * oldest first, so the runner can pull each blob and keep a working copy. The
 * runner matches a turn's `attachment` block to its copy by `attachmentId`.
 */
export interface AttachmentsListForConversationInput {
  conversationId: string;
}
export interface AttachmentsListForConversationOutput {
  files: Array<{
    attachmentId: string;
    filename: string;
    sha256: string;
    mediaType: string;
    sizeBytes: number;
  }>;
}

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the `attachments:*` service hooks (ARCH-13).
//
// Storage-agnostic by construction (I1): `attachmentId` is an opaque id,
// `expiresAt` is an ISO-8601 string, `sizeBytes` a byte count. `sha256` is the
// attachment's OWN content digest (the storage-agnostic identity the alternate
// `@ax/attachments-pg-bytea-only` impl would compute identically), NOT a git
// sha / backend pointer — so it stays. An id that comes back from commit or
// list must be a well-formed attachment id: it lands verbatim in transcript
// blocks. `DownloadOutput.bytes` is a Node `Buffer`, which is a `Uint8Array`
// subclass, so `z.instanceof(Uint8Array)` accepts it and lets the bytes ride
// through by reference. Cast to `ZodType<…>` because the interface declares
// `Buffer` (a structural superset of the schema's inferred `Uint8Array`); the
// drift-guard test enforces field-for-field agreement.
// ---------------------------------------------------------------------------
export const StoreTempOutputSchema = z.object({
  attachmentId: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
}) as unknown as ZodType<StoreTempOutput>;

export const CommitOutputSchema = z.object({
  attachmentId: AttachmentIdSchema,
  filename: z.string(),
  sha256: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number(),
}) as unknown as ZodType<CommitOutput>;

export const DownloadOutputSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  mediaType: z.string(),
  sizeBytes: z.number(),
  displayName: z.string(),
}) as unknown as ZodType<DownloadOutput>;

// TASK-68 returns contracts. Storage-agnostic: `artifactId`/`attachmentId`
// opaque ids, `sha256` the file's own content digest (not a backend pointer).
export const ArtifactsPublishBlobOutputSchema = z.object({
  artifactId: z.string(),
}) as unknown as ZodType<ArtifactsPublishBlobOutput>;

export const AttachmentsListForConversationOutputSchema = z.object({
  files: z.array(
    z.object({
      attachmentId: AttachmentIdSchema,
      filename: z.string(),
      sha256: z.string(),
      mediaType: z.string(),
      sizeBytes: z.number(),
    }),
  ),
}) as unknown as ZodType<AttachmentsListForConversationOutput>;

// Plugin config.

export interface AttachmentsConfig {
  /**
   * Per-file size cap in bytes. Enforced inside `attachments:store-temp`
   * (the HTTP route layer enforces the same cap up front, but this is the
   * defense-in-depth check). Default 25 MiB.
   */
  maxFileBytes?: number;

  /**
   * Per-user pending-attachment quota in bytes. Sum of `size_bytes` across
   * all not-yet-committed temp rows for the same user. Default 200 MiB.
   */
  maxPendingBytesPerUser?: number;

  /**
   * Temp-store TTL in seconds. Default 600 (10 minutes).
   */
  tempTtlSeconds?: number;

  /**
   * Janitor sweep interval in seconds. Default 300 (5 minutes).
   */
  janitorIntervalSeconds?: number;

  /**
   * Allowed MIME types (exact match or `<top>/*` wildcard like `image/*`).
   * Default is an explicit narrow list — image/png, image/jpeg, image/gif,
   * image/webp, application/pdf, text/plain, text/csv, text/markdown,
   * application/json, application/zip, application/octet-stream — chosen
   * over `image/*` / `text/*` wildcards so that `image/svg+xml` (which can
   * carry script) and other long-tail subtypes don't admit by accident.
   * Override via `allowedMediaTypes` if you want broader admission.
   */
  allowedMediaTypes?: string[];
}

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_BYTES_PER_USER = 200 * 1024 * 1024;
export const DEFAULT_TEMP_TTL_SECONDS = 600;
export const DEFAULT_JANITOR_INTERVAL_SECONDS = 300;
export const DEFAULT_ALLOWED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/octet-stream',
];
