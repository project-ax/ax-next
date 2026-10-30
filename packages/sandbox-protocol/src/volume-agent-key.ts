import { createHash } from 'node:crypto';

/** Stable agent directory key for the memory export mount contract. */
export function volumeAgentKey(agentId: string): string {
  return createHash('sha256').update(JSON.stringify([agentId])).digest('hex');
}

/**
 * Where each agent's facts live inside its slot of the memory export volume:
 * `<volumeAgentKey(agentId)>/permanent/memory/facts/…`, mounted read-only at
 * `/memory`. The writer (@ax/memory) and the mount resolvers (@ax/sandbox-k8s)
 * share this literal. Historical value (it once mirrored the facts' path in the
 * git workspace, dropped in TASK-991); it is now on-disk layout.
 */
export const MEMORY_FACTS_EXPORT_ROOT = 'permanent/memory/facts' as const;
