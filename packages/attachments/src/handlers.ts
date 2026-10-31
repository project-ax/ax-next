import { createHash, randomUUID } from 'node:crypto';
import {
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import {
  ATTACHMENT_FILENAME_MAX,
  ATTACHMENT_MEDIA_TYPE_MAX,
  AttachmentIdSchema,
} from '@ax/ipc-protocol';
import type { AttachmentsStore } from './store.js';
import type {
  AttachmentsConfig,
  AttachmentsListForConversationInput,
  AttachmentsListForConversationOutput,
  ArtifactsPublishBlobInput,
  ArtifactsPublishBlobOutput,
  CommitInput,
  CommitOutput,
  DownloadInput,
  DownloadOutput,
  StoreTempInput,
  StoreTempOutput,
} from './types.js';

// TASK-68 (out-of-git Part C): bytes live in the content-addressed blob store,
// reached via the storage-agnostic blob:* bus hooks (NOT an import — I2).
interface BlobPutInput {
  bytes: Uint8Array;
}
interface BlobPutOutput {
  sha256: string;
  size: number;
}
interface BlobGetInput {
  sha256: string;
}
type BlobGetOutput = { bytes: Uint8Array } | { found: false };
interface BlobStatInput {
  sha256: string;
}
type BlobStatOutput = { size: number } | { found: false };
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PENDING_BYTES_PER_USER,
  DEFAULT_TEMP_TTL_SECONDS,
  DEFAULT_JANITOR_INTERVAL_SECONDS,
  DEFAULT_ALLOWED_MEDIA_TYPES,
} from './types.js';

const PLUGIN_NAME = '@ax/attachments';

export interface StoreTempDeps {
  store: AttachmentsStore;
  config: AttachmentsConfig;
}

/**
 * Resolves an AttachmentsConfig to all-required defaults. Centralised so
 * every handler factory in this file applies the same defaults.
 */
export function resolveAttachmentsConfig(
  input: AttachmentsConfig,
): Required<AttachmentsConfig> {
  return {
    maxFileBytes: input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxPendingBytesPerUser:
      input.maxPendingBytesPerUser ?? DEFAULT_MAX_PENDING_BYTES_PER_USER,
    tempTtlSeconds: input.tempTtlSeconds ?? DEFAULT_TEMP_TTL_SECONDS,
    janitorIntervalSeconds:
      input.janitorIntervalSeconds ?? DEFAULT_JANITOR_INTERVAL_SECONDS,
    allowedMediaTypes:
      input.allowedMediaTypes ?? DEFAULT_ALLOWED_MEDIA_TYPES,
  };
}

/**
 * Allowlist match: exact MIME type OR wildcard `<top>/*` (e.g. `image/*`).
 * Anything else is rejected upstream.
 */
function matchesAllowlist(mediaType: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (entry === mediaType) return true;
    if (entry.endsWith('/*')) {
      const prefix = entry.slice(0, -1);
      if (mediaType.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function createStoreTempHandler(deps: StoreTempDeps) {
  const config = resolveAttachmentsConfig(deps.config);
  return async function storeTemp(
    ctx: AgentContext,
    input: StoreTempInput,
  ): Promise<StoreTempOutput> {
    if (input.bytes.length > config.maxFileBytes) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:store-temp',
        message: `attachment exceeds max file size of ${config.maxFileBytes} bytes`,
      });
    }
    if (!matchesAllowlist(input.mediaType, config.allowedMediaTypes)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:store-temp',
        message: `mediaType '${input.mediaType}' not in allowlist`,
      });
    }
    // The name and type ride into the conversation's `attachment` block, which
    // caps both. Refuse here, at upload, rather than mint a block the turn that
    // sends it could not carry.
    if (input.displayName.length === 0 || input.displayName.length > ATTACHMENT_FILENAME_MAX) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:store-temp',
        message: `attachment name must be 1-${ATTACHMENT_FILENAME_MAX} characters`,
      });
    }
    if (input.mediaType.length > ATTACHMENT_MEDIA_TYPE_MAX) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:store-temp',
        message: `attachment media type longer than ${ATTACHMENT_MEDIA_TYPE_MAX} characters`,
      });
    }
    const attachmentId = randomUUID();
    const expiresAt = new Date(Date.now() + config.tempTtlSeconds * 1000);
    // Atomic quota + insert: concurrent uploads for the same user can't
    // both pass the sum-check and double-insert past the quota — the
    // store layer re-checks the sum inside the same transaction and
    // rolls back if the new row pushes total bytes over the limit.
    const result = await deps.store.insertTempIfWithinQuota(
      {
        attachmentId,
        userId: ctx.userId,
        bytes: input.bytes,
        displayName: input.displayName,
        mediaType: input.mediaType,
        sizeBytes: input.bytes.length,
        expiresAt,
      },
      config.maxPendingBytesPerUser,
    );
    if (!result.ok) {
      throw new PluginError({
        code: 'too-many-pending',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:store-temp',
        message: `user pending-attachment quota exceeded (${config.maxPendingBytesPerUser} bytes)`,
      });
    }

    return {
      attachmentId,
      sizeBytes: input.bytes.length,
      expiresAt: expiresAt.toISOString(),
    };
  };
}

export interface CommitDeps {
  store: AttachmentsStore;
  bus: HookBus;
}

/**
 * `attachments:commit` — turn a staged upload into a committed one, owned by
 * the conversation it was sent in. The upload keeps the id it was staged
 * under; that id is what the transcript's `attachment` block, the download and
 * the runner's copy all use. No path is minted: where the bytes live is the
 * blob store's business, and where a copy lands in a sandbox is the runner's.
 *
 * The caller (the chat-messages route) has already checked the person owns
 * `conversationId`; this hook checks the staged upload is theirs.
 */
export function createCommitHandler(deps: CommitDeps) {
  return async function commit(
    ctx: AgentContext,
    input: CommitInput,
  ): Promise<CommitOutput> {
    const row = await deps.store.getTemp(input.attachmentId);
    if (!row) {
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:commit',
        message: `attachmentId '${input.attachmentId}' not found or expired`,
      });
    }
    if (row.userId !== ctx.userId) {
      // I1: leave the temp row intact so the victim's later legitimate
      // redemption isn't disrupted by a hostile probe.
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:commit',
        message: 'attachment owned by a different user',
      });
    }

    // TASK-68: store the bytes in the content-addressed blob store (host-side;
    // no sandbox involved). The store computes + returns the sha256 — we don't
    // forge it. Idempotent: identical bytes are stored once.
    const put = await deps.bus.call<BlobPutInput, BlobPutOutput>(
      'blob:put',
      ctx,
      { bytes: new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength) },
    );

    // Durable metadata row: id → owner, conversation, sha256. The download ACL
    // and the runner's upload list resolve the id back to its blob here.
    const fresh = {
      id: input.attachmentId,
      conversationId: input.conversationId,
      userId: ctx.userId,
      sha256: put.sha256,
      displayName: row.displayName,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
    };
    let stored = fresh;
    if (!(await deps.store.insertFile(fresh))) {
      // The id was committed before and its temp row outlived that commit (the
      // delete below is best-effort). Re-sending into the SAME conversation is
      // the same upload: answer with the row as stored. Anywhere else would
      // hand that conversation a block whose row lives in another one — refuse,
      // and leave the first row alone.
      const existing = await deps.store.getFileById(input.attachmentId);
      if (
        existing === null ||
        existing.conversationId !== input.conversationId ||
        existing.userId !== ctx.userId
      ) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          hookName: 'attachments:commit',
          message: `attachmentId '${input.attachmentId}' was already sent in another conversation`,
        });
      }
      stored = existing;
    }

    // Best-effort delete of the temp row; janitor reaps any leftovers.
    try {
      await deps.store.deleteTemp(input.attachmentId);
    } catch (err) {
      ctx.logger.warn('attachments_commit_temp_delete_failed', {
        attachmentId: input.attachmentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      attachmentId: stored.id,
      filename: stored.displayName,
      sha256: stored.sha256,
      mediaType: stored.mediaType,
      sizeBytes: stored.sizeBytes,
    };
  };
}

// ---------------------------------------------------------------------------
// TASK-68: attachments:list-for-conversation + artifacts:publish-blob.
// ---------------------------------------------------------------------------

export interface ListForConversationDeps {
  store: AttachmentsStore;
}

/**
 * `attachments:list-for-conversation` — returns the conversation's committed
 * uploads (scoped to ctx.userId, so a foreign conversation returns the empty
 * set — no existence leak), oldest first. The runner enumerates these when it
 * starts (and when a later message brings an upload it has not seen) to pull
 * each blob into its own working copy, and matches each turn's `attachment`
 * block to its copy by `attachmentId`. The order is stable, so a fresh runner
 * names its copies the same way every time.
 */
export function createListForConversationHandler(deps: ListForConversationDeps) {
  return async function listForConversation(
    ctx: AgentContext,
    input: AttachmentsListForConversationInput,
  ): Promise<AttachmentsListForConversationOutput> {
    const rows = await deps.store.listFilesForConversation(
      input.conversationId,
      ctx.userId,
    );
    return {
      files: rows.map((r) => ({
        attachmentId: r.id,
        filename: r.displayName,
        sha256: r.sha256,
        mediaType: r.mediaType,
        sizeBytes: r.sizeBytes,
      })),
    };
  };
}

// Local shape of conversations:get — only its success matters here (it is the
// owner gate). Importing the full type from @ax/conversations would create a
// cross-plugin import (I2 violation), so we narrow at the call site instead.
interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}

/**
 * Does ctx.userId own `conversationId`? `conversations:get` is the owner gate:
 * it answers not-found / forbidden for a conversation that is missing, deleted,
 * someone else's, or behind an agent the user can no longer reach. Any other
 * failure is an outage, not an answer, and propagates as itself.
 */
async function callerOwnsConversation(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
): Promise<boolean> {
  try {
    await bus.call<ConversationsGetInput, unknown>('conversations:get', ctx, {
      conversationId,
      userId: ctx.userId,
    });
    return true;
  } catch (err) {
    if (err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden')) {
      return false;
    }
    throw err;
  }
}

export interface PublishArtifactBlobDeps {
  store: AttachmentsStore;
  bus: HookBus;
}

/**
 * `artifacts:publish-blob` — inserts a published-artifact metadata row after the
 * runner streamed the bytes to `blob:put`. Scoped to ctx.userId. Identity is
 * scoped to the conversation and path: identical bytes can be published under
 * different names or in different conversations without a primary-key clash.
 * Idempotent on (conversationId, path); blob deduplication still uses sha256.
 *
 * The row is only written once `blob:stat` confirms the store holds the sha
 * (TASK-776, blob-gc design D10). Without that, a runner could publish a row
 * for bytes that were never put or have since been purged, and the person gets
 * a download link that 404s. It does NOT check that THIS runner put the sha: a
 * sha256 cannot be guessed, so a runner that can name one already has the
 * bytes, and referencing identical bytes is the same as dedup. A `blob:stat`
 * failure propagates — "could not check" must never turn into "assume it is
 * there".
 *
 * Where the row lands decides who can download it (`attachments:download`
 * resolves the id, then requires the row's conversation and owner to match),
 * so the caller must own the conversation, and a re-publish never takes over
 * a row another user wrote.
 */
export function createPublishArtifactBlobHandler(deps: PublishArtifactBlobDeps) {
  return async function publishArtifactBlob(
    ctx: AgentContext,
    input: ArtifactsPublishBlobInput,
  ): Promise<ArtifactsPublishBlobOutput> {
    const stat = await deps.bus.call<BlobStatInput, BlobStatOutput>('blob:stat', ctx, {
      sha256: input.sha256,
    });
    if ('found' in stat && stat.found === false) {
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName: 'artifacts:publish-blob',
        message: 'artifact bytes are not in the blob store',
      });
    }
    if (!(await callerOwnsConversation(deps.bus, ctx, input.conversationId))) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName: 'artifacts:publish-blob',
        message: 'artifacts can be published only into a conversation the caller owns',
      });
    }
    const artifactId = createHash('sha256')
      .update(JSON.stringify([input.conversationId, input.path]))
      .digest('hex').slice(0, 32);
    const written = await deps.store.upsertArtifact({
      id: artifactId,
      conversationId: input.conversationId,
      userId: ctx.userId,
      sha256: input.sha256,
      path: input.path,
      displayName: input.displayName,
      mediaType: input.mediaType,
      sizeBytes: input.size,
    });
    if (!written) {
      // Another user's row already holds this key. With the owner gate above
      // that can only be a row written before the gate existed; leave it be.
      throw new PluginError({
        code: 'conflict',
        plugin: PLUGIN_NAME,
        hookName: 'artifacts:publish-blob',
        message: 'an artifact at this path belongs to another user',
      });
    }
    return { artifactId };
  };
}

export interface DownloadDeps {
  bus: HookBus;
  store: AttachmentsStore;
}

function downloadNotFound(message: string): PluginError {
  return new PluginError({
    code: 'not-found',
    plugin: PLUGIN_NAME,
    hookName: 'attachments:download',
    message,
  });
}

/**
 * `attachments:download` serves an upload or a published artifact BY ID, and
 * is the download ACL. All callers — channel-web today, a future Slack plugin
 * tomorrow — get the same enforcement because the ACL lives inside the hook,
 * not the route layer.
 *
 * The ladder, each step failing closed:
 *   1. the id is well-formed;
 *   2. the caller is who they say (input.userId === ctx.userId);
 *   3. the caller owns the conversation they name (conversations:get);
 *   4. the id resolves to a row (an upload, else an artifact) that belongs to
 *      THAT conversation and was written by that same person;
 *   5. the blob store still holds the bytes.
 *
 * Step 4 is what makes a chip safe to trust: a forged `attachment` block (a
 * crafted client request, or an untrusted runner's turn) can name any id, but
 * an id from another conversation — the same person's or anyone else's — only
 * ever reaches a 404. A conversation has one owner, and every row in it was
 * written by that owner (their upload, or their own runner's publish), so the
 * row-owner check costs nothing legitimate.
 *
 * Every refusal is the same `not-found` (existence-leak prevention: a foreign
 * id and a missing one look identical), and no refusal fetches bytes. A
 * conversations:get failure that is NOT an ACL answer propagates as itself —
 * an outage is not a 404.
 */
export function createDownloadHandler(deps: DownloadDeps) {
  return async function download(
    ctx: AgentContext,
    input: DownloadInput,
  ): Promise<DownloadOutput> {
    if (!AttachmentIdSchema.safeParse(input.attachmentId).success) {
      throw downloadNotFound('file not found');
    }
    if (input.userId !== ctx.userId) {
      throw downloadNotFound('conversation not found');
    }
    if (!(await callerOwnsConversation(deps.bus, ctx, input.conversationId))) {
      throw downloadNotFound('conversation not found');
    }

    // Uploads and artifacts have distinct id shapes (store-temp UUIDs vs hex),
    // so the two lookups never compete for one id.
    const row =
      (await deps.store.getFileById(input.attachmentId)) ??
      (await deps.store.getArtifactById(input.attachmentId));
    if (
      row === null ||
      row.conversationId !== input.conversationId ||
      row.userId !== ctx.userId
    ) {
      throw downloadNotFound('file not found');
    }

    // `blob:get` re-verifies the bytes against the digest on read (TASK-65),
    // so a corrupt or tampered object is refused, never served. Symlink refusal
    // is enforced at WRITE time (artifact_publish lstat; an upload is opaque
    // bytes that can't be a symlink), so there's no symlink to refuse here.
    const got = await deps.bus.call<BlobGetInput, BlobGetOutput>('blob:get', ctx, {
      sha256: row.sha256,
    });
    if ('found' in got && got.found === false) {
      throw downloadNotFound('blob not found');
    }

    // `blob:get` returns a Uint8Array; DownloadOutput.bytes is `Buffer` for
    // caller ergonomics. `Buffer.from(uint8)` is a zero-copy view.
    const bytes = (got as { bytes: Uint8Array }).bytes;
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      bytes: buf,
      mediaType: row.mediaType,
      sizeBytes: buf.length,
      displayName: row.displayName,
    };
  };
}
