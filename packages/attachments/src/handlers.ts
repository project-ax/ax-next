import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  PluginError,
  quotaOwnerKey,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import {
  ATTACHMENT_FILENAME_MAX,
  ATTACHMENT_MEDIA_TYPE_MAX,
  AttachmentIdSchema,
} from '@ax/ipc-protocol';
import type { AttachmentsStore, FileRow } from './store.js';
import type { ArtifactStore, PublishVersionResult } from './artifacts/store.js';
import { describeMediaType, downloadFilename, mediaTypeForPath } from './artifacts/media.js';
import { normalizeArtifactTitle } from './artifacts/title.js';
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

/** The `attachment` block's fields for a committed row. */
function toCommitOutput(row: FileRow): CommitOutput {
  return {
    attachmentId: row.id,
    filename: row.displayName,
    sha256: row.sha256,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
  };
}

/** Is this row already this person's file in this conversation? */
function alreadyCommittedHere(
  row: FileRow | null,
  conversationId: string,
  userId: string,
): row is FileRow {
  return row !== null && row.conversationId === conversationId && row.userId === userId;
}

/**
 * `attachments:commit` — turn a staged upload into a committed one, owned by
 * the conversation it was sent in. The upload keeps the id it was staged
 * under; that id is what the transcript's `attachment` block, the download and
 * the runner's copy all use. No path is minted: where the bytes live is the
 * blob store's business, and where a copy lands in a sandbox is the runner's.
 *
 * Committing an id that is already committed into the same conversation by the
 * same person answers with the row as stored, whether or not its staged row
 * survived (TASK-1063). Any other id without a staged upload gets the not-found
 * an unknown id gets.
 *
 * The caller (the chat-messages route) has already checked the person owns
 * `conversationId`; this hook checks the upload is theirs.
 */
export function createCommitHandler(deps: CommitDeps) {
  return async function commit(
    ctx: AgentContext,
    input: CommitInput,
  ): Promise<CommitOutput> {
    const row = await deps.store.getTemp(input.attachmentId);
    if (!row) {
      // TASK-1063: no staged row is the usual state after a commit (the commit
      // below deletes it). Naming the id again into the same conversation, as
      // the same person, is how Resend carries a file again after a turn that
      // was refused before the message was saved. It grants nothing new: the
      // person can already download that file there. Every other miss
      // (unknown, someone else's, another conversation) gets the same
      // not-found, so the answer never says whose file it is or where it lives.
      const existing = await deps.store.getFileById(input.attachmentId);
      if (alreadyCommittedHere(existing, input.conversationId, ctx.userId)) {
        return toCommitOutput(existing);
      }
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
    let stored: FileRow = fresh;
    if (!(await deps.store.insertFile(fresh))) {
      // The rarer twin of the no-staged-row branch above: the id was committed
      // before and its temp row outlived that commit (the delete below is
      // best-effort). Same rule: into the SAME conversation, by the same
      // person, it is the same upload, so answer with the row as stored.
      // Anywhere else would hand that conversation a block whose row lives in
      // another one — refuse, and leave the first row alone.
      const existing = await deps.store.getFileById(input.attachmentId);
      if (!alreadyCommittedHere(existing, input.conversationId, ctx.userId)) {
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

    return toCommitOutput(stored);
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

// Local shapes of conversations:get and agents:resolve — only the fields used
// here. Importing the full types would be a cross-plugin import (I2 violation),
// so we narrow at the call site instead, and treat the answers as untrusted.
interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}
interface AgentsResolveInput {
  agentId: string;
  userId: string;
}

function isAclRefusal(err: unknown): boolean {
  return err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden');
}

/**
 * Does ctx.userId own `conversationId`, and which agent is it with?
 * `conversations:get` is the owner gate: it answers not-found / forbidden for a
 * conversation that is missing, deleted, someone else's, or behind an agent the
 * user can no longer reach — all of which come back as null here, as does an
 * answer without a usable agent id (fail closed). Any other failure is an
 * outage, not an answer, and propagates as itself.
 */
async function ownedConversationAgent(
  bus: HookBus,
  ctx: AgentContext,
  conversationId: string,
): Promise<string | null> {
  let out: unknown;
  try {
    out = await bus.call<ConversationsGetInput, unknown>('conversations:get', ctx, {
      conversationId,
      userId: ctx.userId,
    });
  } catch (err) {
    if (isAclRefusal(err)) return null;
    throw err;
  }
  const agentId = (out as { conversation?: { agentId?: unknown } } | null)?.conversation?.agentId;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
}

export interface PublishArtifactDeps {
  artifacts: ArtifactStore;
  bus: HookBus;
}

export interface PublishArtifactInput {
  /** The chat it is published from; the caller must own it. */
  conversationId: string;
  sha256: string;
  /** Relative to the agent's files root: the re-publish key. */
  sourcePath: string;
  /** The agent's proposed title (untrusted); normalized, else the file name. */
  title: unknown;
  /** Re-publish this artifact rather than the one keyed by `sourcePath`. */
  artifactId?: string;
}

function publishRefusal(hookName: string, code: 'forbidden' | 'not-found', message: string): PluginError {
  return new PluginError({ code, plugin: PLUGIN_NAME, hookName, message });
}

/**
 * The one publish chain, shared by every hook that publishes an artifact:
 *   1. the caller owns the conversation (and it names the agent);
 *   2. the agent resolves for the caller, which names the quota owner (C4);
 *   3. the blob store holds the sha, and says its size (D10);
 *   4. the media type comes from the path, never the caller;
 *   5. the title is normalized, falling back to the file name;
 *   6. one store transaction adds the version.
 *
 * Ownership comes first: a caller refused there must not learn, from a
 * not-found vs forbidden split, whether a sha is in the store. A blob:stat or
 * agents:resolve outage propagates — "could not check" never turns into
 * "assume it is fine".
 *
 * This does NOT check that the caller put the sha, and a sha is not proof the
 * caller holds the bytes: hashes leak into model-visible text, and the store is
 * shared. That check is the untrusted caller's boundary, ipc-core's
 * `artifact.publish`, which accepts only a sha its own session's `blob.put`
 * returned (TASK-1010). A host-side caller must pass a sha it put itself.
 */
export async function publishArtifact(
  deps: PublishArtifactDeps,
  ctx: AgentContext,
  hookName: string,
  input: PublishArtifactInput,
): Promise<PublishVersionResult> {
  const agentId = await ownedConversationAgent(deps.bus, ctx, input.conversationId);
  if (agentId === null) {
    throw publishRefusal(hookName, 'forbidden', 'artifacts can be published only into a conversation the caller owns');
  }
  let resolved: unknown;
  try {
    resolved = await deps.bus.call<AgentsResolveInput, unknown>('agents:resolve', ctx, {
      agentId,
      userId: ctx.userId,
    });
  } catch (err) {
    if (isAclRefusal(err)) {
      throw publishRefusal(hookName, 'forbidden', 'artifacts can be published only into a conversation the caller owns');
    }
    throw err;
  }
  const agent = (resolved as { agent?: { ownerId?: unknown; ownerType?: unknown } } | null)?.agent;
  if (typeof agent?.ownerId !== 'string' || agent.ownerId.length === 0) {
    throw publishRefusal(hookName, 'forbidden', 'the conversation\'s agent has no usable owner');
  }
  const quotaOwner = quotaOwnerKey({
    ownerType: agent.ownerType === 'team' ? 'team' : 'user',
    ownerId: agent.ownerId,
  });

  const stat = await deps.bus.call<BlobStatInput, BlobStatOutput>('blob:stat', ctx, {
    sha256: input.sha256,
  });
  if ('found' in stat && stat.found === false) {
    throw publishRefusal(hookName, 'not-found', 'artifact bytes are not in the blob store');
  }
  const sizeBytes = (stat as { size: number }).size;

  const title =
    normalizeArtifactTitle(input.title) ??
    normalizeArtifactTitle(posix.basename(input.sourcePath)) ??
    'Untitled';

  return deps.artifacts.publishVersion({
    agentId,
    ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
    sourcePath: input.sourcePath,
    title,
    sha256: input.sha256,
    mediaType: mediaTypeForPath(input.sourcePath),
    sizeBytes,
    conversationId: input.conversationId,
    publishedBy: ctx.userId,
    quotaOwner,
  });
}

/**
 * `artifacts:publish-blob` — the IPC `artifact.publish` action calls this after
 * the runner streamed the bytes to `blob:put`. Same I/O as ever; underneath it
 * is the shared publish chain (`publishArtifact`): the artifact is the agent's,
 * keyed by `path` within it, and a re-publish of the same path adds a version
 * to the same artifact. `mediaType` and `size` in the input are no longer
 * trusted: the type comes from the path, the size from the blob store.
 */
export function createPublishArtifactBlobHandler(deps: PublishArtifactDeps) {
  return async function publishArtifactBlob(
    ctx: AgentContext,
    input: ArtifactsPublishBlobInput,
  ): Promise<ArtifactsPublishBlobOutput> {
    const result = await publishArtifact(deps, ctx, 'artifacts:publish-blob', {
      conversationId: input.conversationId,
      sha256: input.sha256,
      sourcePath: input.path,
      title: input.displayName,
    });
    if (!result.ok) {
      // Unreachable without an artifactId; kept so a refusal is never a success.
      throw new PluginError({
        code: 'conflict',
        plugin: PLUGIN_NAME,
        hookName: 'artifacts:publish-blob',
        message: `artifact could not be published (${result.reason})`,
      });
    }
    return { artifactId: result.artifactId };
  };
}

export interface DownloadDeps {
  bus: HookBus;
  store: AttachmentsStore;
  artifacts: ArtifactStore;
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
 *   3. the caller owns the conversation they name (conversations:get), which
 *      also names that conversation's agent;
 *   4. the id resolves to
 *        - an upload that belongs to THAT conversation and was written by that
 *          same person, or else
 *        - an artifact of THAT conversation's agent (artifacts are the agent's
 *          and outlive the chat that made them, D12), served at its CURRENT
 *          version — an old chip downloads what the artifact is now;
 *   5. the blob store still holds the bytes.
 *
 * Step 4 is what makes a chip safe to trust: a forged `attachment` block (a
 * crafted client request, or an untrusted runner's turn) can name any id, but
 * an upload from another conversation, or an artifact of another agent, only
 * ever reaches a 404.
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
    const agentId = await ownedConversationAgent(deps.bus, ctx, input.conversationId);
    if (agentId === null) {
      throw downloadNotFound('conversation not found');
    }

    // Uploads and artifacts have distinct id shapes (store-temp UUIDs vs hex),
    // so the two lookups never compete for one id.
    let row: { sha256: string; mediaType: string; displayName: string };
    const file = await deps.store.getFileById(input.attachmentId);
    if (file !== null) {
      if (file.conversationId !== input.conversationId || file.userId !== ctx.userId) {
        throw downloadNotFound('file not found');
      }
      row = file;
    } else {
      const head = await deps.artifacts.getHead(input.attachmentId);
      if (head === null || head.agentId !== agentId) {
        throw downloadNotFound('file not found');
      }
      row = {
        sha256: head.current.sha256,
        mediaType: head.current.mediaType,
        displayName: downloadFilename(head.title, describeMediaType(head.current.mediaType).extension),
      };
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
