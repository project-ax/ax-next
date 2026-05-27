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

// TASK-54 — Allowed sites (the durable per-(user, agent) "always allow" grants,
// design P3/P6; backed by @ax/host-grants from TASK-44). The Settings mirror of
// the reactive wall's "Always for this agent" choice.

export interface AllowedSite {
  host: string;
  grantedAt: string;
}
export interface AllowedSitesResponse {
  agentId: string;
  hosts: AllowedSite[];
}

export async function getAllowedSites(agentId: string): Promise<AllowedSitesResponse> {
  const res = await fetch(`/api/chat/allowed-sites/${encodeURIComponent(agentId)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`allowed-sites: ${res.status}`);
  return (await res.json()) as AllowedSitesResponse;
}

/**
 * Revoke a durable host grant. The server removes the persisted grant so it is
 * not re-loaded into the next session's allowlist (the mirror of the in-chat
 * "always" grant — design P6). Idempotent: a 204 even if no row existed.
 */
export async function revokeAllowedSite(agentId: string, host: string): Promise<void> {
  const res = await fetch(
    `/api/chat/allowed-sites/${encodeURIComponent(agentId)}/${encodeURIComponent(host)}`,
    { method: 'DELETE', headers: csrfHeader, credentials: 'include' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`revoke-site: ${res.status}`);
}

// TASK-54 — account-usage: service → the skill ids that declare `account:
// <service>`, derived server-side from skills:list. Powers the Keys tab's
// "used by" hint for service-keyed vault entries (design P2/P6).
export async function getAccountUsage(): Promise<Record<string, string[]>> {
  const res = await fetch('/api/chat/account-usage', { credentials: 'include' });
  if (!res.ok) throw new Error(`account-usage: ${res.status}`);
  const body = (await res.json()) as { usage: Record<string, string[]> };
  return body.usage;
}
