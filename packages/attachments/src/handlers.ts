import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import type { AttachmentsStore } from './store.js';
import type {
  AttachmentsConfig,
  CommitInput,
  CommitOutput,
  DownloadInput,
  DownloadOutput,
  StoreTempInput,
  StoreTempOutput,
} from './types.js';
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
 * Collapse a user-supplied filename to a path-safe component. Preserves the
 * extension; everything outside [A-Za-z0-9._-] collapses to `_`. Prefixed
 * with 8 random hex chars to prevent collisions inside the same
 * (conversationId, turnId) tuple — two uploads named "foo.pdf" don't clash.
 *
 * Leading dots are stripped so the file never becomes "hidden".
 */
function sanitizeFilenameComponent(displayName: string): string {
  const sanitized = displayName.replace(/[^A-Za-z0-9._-]/g, '_');
  const collapsedUnderscores = sanitized.replace(/_+/g, '_');
  // Collapse any run of two-or-more dots to a single dot. This kills the
  // `..` path-traversal vocabulary while preserving the file extension.
  const collapsedDots = collapsedUnderscores.replace(/\.{2,}/g, '.');
  const noDotLead = collapsedDots.replace(/^\.+/, '');
  const prefix = randomBytes(4).toString('hex'); // 8 hex chars
  return `${prefix}__${noDotLead}`;
}

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

    const filenameComponent = sanitizeFilenameComponent(row.displayName);
    const path = `.ax/uploads/${input.conversationId}/${input.turnId}/${filenameComponent}`;
    const sha256 = createHash('sha256').update(row.bytes).digest('hex');

    await deps.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx,
      {
        changes: [{ path, kind: 'put', content: row.bytes }],
        // parent: null — no CAS check. workspace:apply applies on top of
        // current HEAD. CAS belongs to flows that need optimistic locking
        // (e.g. parallel agent edits); attachments are write-once-on-commit.
        parent: null,
        reason: `attachments:commit ${input.attachmentId}`,
      },
    );

    // Best-effort delete; janitor reaps any leftovers.
    try {
      await deps.store.deleteTemp(input.attachmentId);
    } catch (err) {
      ctx.logger.warn('attachments_commit_temp_delete_failed', {
        attachmentId: input.attachmentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      path,
      sha256,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      displayName: row.displayName,
    };
  };
}

export interface DownloadDeps {
  bus: HookBus;
}

/**
 * Normalize a candidate path. Returns null if the path is invalid (the caller
 * surfaces this as `not-found` for uniform existence-leak shape — a malformed
 * path and a missing file look identical to the requester).
 *
 * Valid path constraints:
 *   - 1 <= length <= 1024
 *   - no leading `/` (absolute paths are sandbox-vocab; workspace paths are relative)
 *   - no `..` segments (path traversal)
 *   - no empty segments (catches both `//` and trailing `/`)
 */
function normalizePath(path: string): string | null {
  if (path.length === 0 || path.length > 1024) return null;
  if (path.startsWith('/')) return null;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
    if (seg === '') return null;
  }
  return path;
}

/**
 * Path-scope check. Path must be either:
 *   1. under `.ax/uploads/<conversationId>/`, OR
 *   2. referenced from some `attachment` block in this conversation's
 *      transcript, OR
 *   3. referenced from some `artifact_publish` tool_result in this
 *      conversation's transcript (the tool_result's JSON-encoded content
 *      contains a matching `path` field).
 *
 * Returns the matching block's display metadata so the route layer can
 * populate Content-Disposition headers. Returns null if not in scope.
 *
 * Iteration order: we scan turns first for an exact-match block (which
 * carries authoritative user-supplied displayName + mediaType), THEN
 * fall back to the uploads-prefix branch. This means an uploaded path
 * always resolves to the transcript's metadata when present.
 */
function checkPathScope(
  candidatePath: string,
  conversationId: string,
  turns: Array<{ contentBlocks: ContentBlock[] }>,
): { displayName: string; mediaType: string; sizeBytes: number } | null {
  const uploadsPrefix = `.ax/uploads/${conversationId}/`;

  for (const turn of turns) {
    for (const block of turn.contentBlocks) {
      if (block.type === 'attachment' && block.path === candidatePath) {
        return {
          displayName: block.displayName,
          mediaType: block.mediaType,
          sizeBytes: block.sizeBytes,
        };
      }
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        try {
          const parsed = JSON.parse(block.content) as Record<string, unknown>;
          if (parsed && parsed.path === candidatePath) {
            return {
              displayName: String(parsed.displayName ?? 'file'),
              mediaType: String(parsed.mediaType ?? 'application/octet-stream'),
              sizeBytes: Number(parsed.sizeBytes ?? 0),
            };
          }
        } catch {
          /* not JSON — ignore, this tool_result isn't an artifact_publish */
        }
      }
    }
  }

  // Fall back: path is under the uploads prefix but no matching block.
  // This handles uploaded-but-not-yet-sent (theoretical — attachments:commit
  // always runs from the message-send path which appends a block, so in
  // practice the transcript scan above wins).
  if (candidatePath.startsWith(uploadsPrefix)) {
    return {
      displayName: candidatePath.split('/').pop() ?? 'file',
      mediaType: 'application/octet-stream',
      sizeBytes: 0,
    };
  }

  return null;
}

// Local shape of conversations:get — kept narrow to only what this handler
// uses (turns.contentBlocks). The full Conversation row carries more fields,
// but I3 says one source of truth per concept — we don't redeclare the row
// shape here. Importing the full type from @ax/conversations would create a
// cross-plugin import (I2 violation), so we narrow at the call site instead.
interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}
interface ConversationsGetOutput {
  conversation: { conversationId: string; userId: string; agentId: string };
  turns: Array<{ contentBlocks: ContentBlock[] }>;
}

/**
 * `attachments:download` is the path-scope ACL. All callers — channel-web
 * today, future Slack plugin tomorrow — get the same enforcement because the
 * ACL lives inside the hook, not the route layer.
 *
 * Failure-mode contract (I1, existence-leak prevention):
 *   - foreign conversation -> not-found
 *   - forbidden from conversations:get -> not-found
 *   - malformed path -> not-found
 *   - path outside conversation scope -> forbidden
 *   - file missing from workspace -> not-found
 *
 * Layered ordering is load-bearing: normalize -> owner-gate -> path-scope ->
 * workspace:read. Each layer fails closed.
 */
export function createDownloadHandler(deps: DownloadDeps) {
  return async function download(
    ctx: AgentContext,
    input: DownloadInput,
  ): Promise<DownloadOutput> {
    // 1) Path normalization. Invalid input collapses to not-found so the
    //    response shape is uniform regardless of whether the path was
    //    malformed or just missing (existence-leak prevention).
    const normalized = normalizePath(input.path);
    if (normalized === null) {
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:download',
        message: 'invalid path',
      });
    }

    // 2) Owner gate via conversations:get. The hook input declares the
    //    user identity but ctx.userId is the auth boundary — if a caller
    //    passes a mismatched input.userId they're either confused or
    //    probing, so collapse to the same not-found we'd return for any
    //    other foreign access (uniform existence-leak prevention).
    if (input.userId !== ctx.userId) {
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:download',
        message: 'conversation not found',
      });
    }
    let turns: Array<{ contentBlocks: ContentBlock[] }>;
    try {
      const got = await deps.bus.call<
        ConversationsGetInput,
        ConversationsGetOutput
      >('conversations:get', ctx, {
        conversationId: input.conversationId,
        userId: ctx.userId,
      });
      turns = got.turns;
    } catch (err) {
      if (
        err instanceof PluginError &&
        (err.code === 'not-found' || err.code === 'forbidden')
      ) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          hookName: 'attachments:download',
          message: 'conversation not found',
        });
      }
      throw err;
    }

    // 3) Path-scope check. Either under .ax/uploads/<conv>/ or referenced
    //    from a transcript block. Otherwise forbidden.
    const scopeMeta = checkPathScope(normalized, input.conversationId, turns);
    if (scopeMeta === null) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:download',
        message: 'path not in conversation scope',
      });
    }

    // 4) workspace:read. Symlink refusal is enforced at write-time in
    //    Phase 2 (artifact_publish lstat-rejects; attachments:commit takes
    //    Buffer bytes and can't create a symlink). Read-time symlink
    //    refusal would require extending WorkspaceReadResponseSchema with a
    //    `mode` field — separate schema-level change, not blocking Phase 1.
    const readResult = await deps.bus.call<
      WorkspaceReadInput,
      WorkspaceReadOutput
    >('workspace:read', ctx, { path: normalized });
    if (!readResult.found) {
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:download',
        message: 'file not in workspace',
      });
    }

    // WorkspaceReadOutput.bytes is `Bytes` (Uint8Array). DownloadOutput.bytes
    // is `Buffer` for caller ergonomics. `Buffer.from(uint8)` is a zero-copy
    // view over the same memory.
    const buf = Buffer.from(readResult.bytes);
    return {
      bytes: buf,
      mediaType: scopeMeta.mediaType,
      sizeBytes: buf.length,
      displayName: scopeMeta.displayName,
    };
  };
}
