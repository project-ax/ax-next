import { volumeAgentKey, isValidSharedFolderId } from '@ax/sandbox-protocol';
import { MEMORY_FACTS_EXPORT_ROOT } from '@ax/core';
import { createHash } from 'node:crypto';

/** Compare deployed storage configuration without accepting source paths in API requests. */
export function backingProfile(config: { userFiles: { server: string; exportPath: string };
  memory?: { server: string; exportPath: string } }): string {
  return createHash('sha256').update(JSON.stringify([config.userFiles.server, config.userFiles.exportPath,
    config.memory?.server ?? null, config.memory?.exportPath ?? null])).digest('hex');
}

/** Current mount-resolver layouts. Never accept a path from the activation API. */
export function sourceParts(agentId: string, role: 'user-files' | 'memory'): string[] {
  return role === 'user-files' ? [agentId] : [
    volumeAgentKey(agentId), ...MEMORY_FACTS_EXPORT_ROOT.split('/'),
  ];
}

/**
 * W2 §3.8.1 — a shared folder's place on the user-files export, derived from
 * its id alone. Re-validates the id: this is the one place the helper turns a
 * folder id into path components, so nothing else may reach a mount.
 */
export function sharedFolderSourceParts(folderId: string): string[] {
  if (!isValidSharedFolderId(folderId)) throw new Error('invalid shared folder id');
  return [SHARED_FOLDERS_ROOT, folderId];
}
/** The directory on the user-files export that holds every shared folder. */
export const SHARED_FOLDERS_ROOT = '.shared';
/** Where a shared folder binds under the pod's late-bind volume. */
export function sharedFolderTargetParts(folderId: string): string[] {
  return ['shared', ...sharedFolderSourceParts(folderId).slice(1)];
}
