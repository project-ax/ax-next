import type { Agent } from '../../mock/agents';
import { agentStoreActions } from './agent-store';

/**
 * Fetch the caller's agent list once and push it into the store.
 *
 * Sets `agentsStatus`:
 *   - 'ready'  on a successful load (INCLUDING an empty list — that's the
 *              signal the first-run bootstrap gate keys off).
 *   - 'error'  on a non-ok response, a non-array body, or a thrown fetch.
 *              We deliberately do NOT set agents to [] on error: a transient
 *              blip must not push an existing user into the create flow.
 *
 * Safe to call on demand (e.g. to re-hydrate after creating an agent).
 */
export async function hydrateAgentsOnce(): Promise<void> {
  try {
    const res = await fetch('/api/chat/agents', { credentials: 'include' });
    if (!res.ok) {
      agentStoreActions.setAgentsError();
      return;
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      agentStoreActions.setAgentsError();
      return;
    }
    const wireAgents = body as Array<{
      agentId: string;
      displayName: string;
      visibility: 'personal' | 'team';
    }>;
    const mapped: Agent[] = wireAgents.map((a) => ({
      id: a.agentId,
      owner_id: '',
      owner_type: a.visibility === 'team' ? ('team' as const) : ('user' as const),
      name: a.displayName,
      tag: '',
      desc: '',
      color: agentColorFor(a.agentId),
      system_prompt: '',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    }));
    agentStoreActions.setAgents(mapped);
  } catch (err) {
    console.warn('[hydrate-agents] failed', err);
    agentStoreActions.setAgentsError();
  }
}

export function agentColorFor(agentId: string): string {
  const palette = ['#7aa6c9', '#b08968', '#9c89b8', '#90a955', '#d4a373', '#9b5de5'];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? '#888';
}
