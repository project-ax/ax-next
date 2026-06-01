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
const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

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

// TASK-126 — Skills app-store. The "Not installed · available in your workspace"
// shelf reads the workspace's vetted GLOBAL catalog; self-installing one is a
// per-(user, agent) attachment (the server forces identity + validates the id ∈
// catalog). Both wraps mirror the connections posture (credentials:'include';
// CSRF header on the state-changing POST).

export interface CatalogSkillListing {
  skillId: string;
  description: string;
  defaultAttached: boolean;
  /** Connector-id references the skill declares (its reach; TASK-100). */
  connectors: string[];
}

/** List the workspace's global catalog as installable listings (every user). */
export async function listCatalogSkills(): Promise<CatalogSkillListing[]> {
  const res = await fetch('/api/chat/catalog-skills', { credentials: 'include' });
  if (!res.ok) throw new Error(`catalog-skills: ${res.status}`);
  const body = (await res.json()) as { skills: CatalogSkillListing[] };
  return body.skills;
}

/**
 * Self-install a vetted catalog skill onto an agent (a user-scoped attach). The
 * server forces the caller identity, ACL-checks the agent (404), and rejects a
 * skillId that isn't a real global-catalog id. Returns whether a new attachment
 * row was created (false = already installed; idempotent).
 */
export async function attachConnectionSkill(
  agentId: string,
  skillId: string,
): Promise<{ created: boolean }> {
  const res = await fetch(
    `/api/chat/connections/${encodeURIComponent(agentId)}/skills`,
    {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ skillId }),
    },
  );
  if (!res.ok) throw new Error(`attach: ${res.status}`);
  return (await res.json()) as { created: boolean };
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
