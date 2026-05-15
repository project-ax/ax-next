import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
} from '@ax/core';
import type { AttachmentsStore } from './store.js';
import type {
  AttachmentsConfig,
  CommitInput,
  CommitOutput,
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
    const existing = await deps.store.sumPendingBytesForUser(ctx.userId);
    if (existing + input.bytes.length > config.maxPendingBytesPerUser) {
      throw new PluginError({
        code: 'too-many-pending',
        plugin: PLUGIN_NAME,
        hookName: 'attachments:store-temp',
        message: `user pending-attachment quota exceeded (${config.maxPendingBytesPerUser} bytes)`,
      });
    }

    const attachmentId = randomUUID();
    const expiresAt = new Date(Date.now() + config.tempTtlSeconds * 1000);
    await deps.store.insertTemp({
      attachmentId,
      userId: ctx.userId,
      bytes: input.bytes,
      displayName: input.displayName,
      mediaType: input.mediaType,
      sizeBytes: input.bytes.length,
      expiresAt,
    });

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
