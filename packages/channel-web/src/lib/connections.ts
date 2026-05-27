/**
 * Connections wire client (TASK-42) — typed wrappers around
 * `/api/chat/connections/*`, the Settings "Connections" BFF surface.
 *
 * Mirrors `lib/credentials.ts`'s CSRF posture: `credentials: 'include'` so the
 * auth cookie rides along; the state-changing DELETE carries
 * `x-requested-with: ax-admin` so it passes @ax/http-server's CSRF gate. The
 * server forces the user scope from the cookie — these calls never send a user
 * id.
 */
const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

export interface ConnectionSkill {
  skillId: string;
  description: string;
  source: 'default' | 'agent' | 'user';
  removable: boolean;
}
export interface ConnectionsResponse {
  agentId: string;
  skills: ConnectionSkill[];
}

export async function getConnections(agentId: string): Promise<ConnectionsResponse> {
  const res = await fetch(`/api/chat/connections/${encodeURIComponent(agentId)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`connections: ${res.status}`);
  return (await res.json()) as ConnectionsResponse;
}

export async function detachConnectionSkill(agentId: string, skillId: string): Promise<void> {
  const res = await fetch(
    `/api/chat/connections/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
    { method: 'DELETE', headers: csrfHeader, credentials: 'include' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`detach: ${res.status}`);
}
