import { MEMORY_FACTS_EXPORT_ROOT, volumeAgentKey } from '@ax/sandbox-protocol';
import { createHash } from 'node:crypto';
import { isLegacySharedFolderId } from './protocol.js';

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
 * W2 legacy (TASK-904): where a W2-era helper bound a shared folder under the
 * pod's late-bind volume. Release only, never a bind. Re-checks the id, because
 * this is the one place a folder id becomes path components: nothing else may
 * reach an unmount.
 */
export function legacySharedFolderTargetParts(folderId: string): string[] {
  if (!isLegacySharedFolderId(folderId)) throw new Error('invalid shared folder id');
  return ['shared', folderId];
}
