import { volumeAgentKey } from '@ax/sandbox-protocol';
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
