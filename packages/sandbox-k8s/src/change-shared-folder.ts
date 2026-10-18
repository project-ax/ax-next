import { PluginError, type Logger } from '@ax/core';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import type {
  ChangeSharedFolderInput,
  ChangeSharedFolderOutput,
  SharedFolderChange,
} from '@ax/sandbox-mount-protocol';
import {
  MAX_CHANGE_COUNT,
  MAX_CHANGE_FILE_BYTES,
  MAX_CHANGE_TOTAL_BYTES,
  WalkChangeError,
  WalkPathError,
} from '@ax/user-files-read';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { StorageClient } from './storage-client.js';
import type { ChangeSharedWireRequest } from './storage-node/protocol.js';

// ---------------------------------------------------------------------------
// sandbox:change-shared-folder (W3c) — the host's WRITE path into one shared
// folder, for @ax/projects (which checks the person may edit the project, and
// the path, first; this hook does no grant check, like
// sandbox:read-shared-folder).
//
// The host can't write the export itself: its mount is read-only, `.shared`
// is root-owned 0711, and agents need what people save to be owned by 1000.
// So the writes go to the privileged storage node's `/change-shared` route
// (mTLS, controller certificate only), which runs `changeConfinedByWalk` on
// the writable export with chown to 1000. Any Ready helper will do: they all
// mount the same export.
//
// The caps and the folder id are checked here too, before ~35 MB of base64 is
// built and sent; the node checks them again (it trusts nothing on its wire),
// and so does the walk.
//
// Answers:
// - `unavailable` without a shared pool (no storage node to ask). Decided
//   before the input is consulted, so it is the same for every folder.
// - `done` with the node's results (a `conflict` is the last result).
// - A REFUSAL throws PluginError `invalid-payload` with `reasonCode` = the
//   walk's code (`invalid-path`, `too-large`, `too-many-changes`,
//   `invalid-change`, `link-or-not-dir`, `not-empty`, `is-directory`) —
//   the same shape sandbox-subprocess throws. The cause is a WalkChangeError
//   (or WalkPathError) carrying `applied`: the changes that took effect first.
// - A missing folder without `createFolder` throws `shared-folder-missing`.
// - No Ready helper, a node failure or a bad reply throws
//   `shared-folder-change-failed`. The node may have applied some changes; a
//   retry is safe for `ifMatch` / `ifAbsent` writes.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/sandbox-k8s';
const HOOK = 'sandbox:change-shared-folder';

function hookError(code: string, message: string, extra: { cause?: unknown; reasonCode?: string } = {}): PluginError {
  return new PluginError({
    code,
    plugin: PLUGIN_NAME,
    hookName: HOOK,
    message,
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
    ...(extra.reasonCode !== undefined ? { reasonCode: extra.reasonCode } : {}),
  });
}

function refuse(reasonCode: string, message: string, cause?: unknown): PluginError {
  return hookError('invalid-payload', message, { reasonCode, ...(cause !== undefined ? { cause } : {}) });
}

/** Validate the input and build the wire request (content as base64). */
function toWire(input: ChangeSharedFolderInput): ChangeSharedWireRequest {
  const folderId: unknown = (input as { folderId?: unknown } | null)?.folderId;
  if (!isValidSharedFolderId(folderId)) throw refuse('invalid-change', 'invalid shared folder id');
  const changes: unknown = input.changes;
  if (!Array.isArray(changes)) throw refuse('invalid-change', 'changes must be an array');
  if (changes.length > MAX_CHANGE_COUNT) {
    throw refuse('too-many-changes', `more than ${MAX_CHANGE_COUNT} changes`);
  }
  let total = 0;
  const wire = (changes as SharedFolderChange[]).map((change): ChangeSharedWireRequest['changes'][number] => {
    if (typeof change?.path !== 'string') throw refuse('invalid-change', 'a change needs a path');
    switch (change.op) {
      case 'write': {
        if (!(change.content instanceof Uint8Array)) throw refuse('invalid-change', 'write content must be bytes');
        if (change.content.length > MAX_CHANGE_FILE_BYTES) throw refuse('too-large', 'a file is too large');
        total += change.content.length;
        if (total > MAX_CHANGE_TOTAL_BYTES) throw refuse('too-large', 'the changes are too large');
        const content = Buffer.from(change.content.buffer, change.content.byteOffset, change.content.byteLength)
          .toString('base64');
        return {
          op: 'write', path: change.path, content,
          ...(change.ifMatch !== undefined ? { ifMatch: change.ifMatch } : {}),
          ...(change.ifAbsent === true ? { ifAbsent: true as const } : {}),
        };
      }
      case 'mkdir':
        return { op: 'mkdir', path: change.path, ...(change.ifAbsent === true ? { ifAbsent: true as const } : {}) };
      case 'delete':
        return { op: 'delete', path: change.path };
      default:
        throw refuse('invalid-change', 'unknown change op');
    }
  });
  return { folderId, ...(input.createFolder === true ? { createFolder: true as const } : {}), changes: wire };
}

/** Realize `sandbox:change-shared-folder` for the k8s provider. */
export async function changeSharedFolder(
  config: ResolvedSandboxK8sConfig,
  client: StorageClient | undefined,
  input: ChangeSharedFolderInput,
  log: Logger,
): Promise<ChangeSharedFolderOutput> {
  if (!config.sharedPool || client === undefined) return { kind: 'unavailable' };
  const request = toWire(input);
  const { folderId } = request;
  let reply;
  try {
    reply = await client.changeShared(request);
  } catch (cause) {
    log.warn('shared_folder_change_failed', { folderId, error: cause instanceof Error ? cause.message : String(cause) });
    throw hookError('shared-folder-change-failed', `could not change shared folder '${folderId}'`, { cause });
  }
  if (reply.kind === 'done') {
    log.info('shared_folder_changed', {
      folderId,
      changes: request.changes.length,
      applied: reply.results.length,
      conflict: reply.results.at(-1)?.outcome === 'conflict',
    });
    return { kind: 'done', results: reply.results };
  }
  log.info('shared_folder_change_refused', { folderId, reasonCode: reply.refused, applied: reply.results.length });
  if (reply.refused === 'missing-folder') {
    throw hookError('shared-folder-missing', `shared folder '${folderId}' does not exist`, { reasonCode: 'missing-folder' });
  }
  if (reply.refused === 'invalid-path') {
    throw refuse('invalid-path', 'invalid change path', new WalkPathError('invalid change path'));
  }
  const cause = new WalkChangeError(`change refused: ${reply.refused}`, {
    code: reply.refused, index: reply.results.length, applied: reply.results,
  });
  throw refuse(reply.refused, `change refused: ${reply.refused}`, cause);
}
