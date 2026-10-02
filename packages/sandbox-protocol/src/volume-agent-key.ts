import { createHash } from 'node:crypto';

/** Stable agent directory key for the memory export mount contract. */
export function volumeAgentKey(agentId: string): string {
  return createHash('sha256').update(JSON.stringify([agentId])).digest('hex');
}
