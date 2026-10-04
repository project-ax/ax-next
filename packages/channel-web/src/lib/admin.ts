/**
 * Admin client — typed wrappers around `/admin/*`.
 *
 * Path convention matches `lib/auth.ts` (`/admin/me`, `/admin/sign-out`)
 * and the real backend's route registrations (`@ax/agents`,
 * `@ax/mcp-client`, `@ax/teams` all mount at `/admin/*`, no `/api`
 * prefix).
 *
 * Wire shape for /admin/agents is the real backend's camelCase contract
 * (see packages/agents/src/admin-routes.ts):
 *   GET  /admin/agents       → { agents: AdminAgent[] }
 *   POST /admin/agents       body: AdminAgentInput              → { agent }
 *   PATCH /admin/agents/:id  body: Partial<AdminAgentInput>     → { agent }
 *   DELETE /admin/agents/:id                                    → 204
 *
 * SECURITY NOTE — every endpoint these helpers hit is guarded server-side
 * by the admin role check. Hiding admin entries from non-admins in the
 * UI is a convenience; access control sits on the server.
 *
 * CSRF — state-changing methods (POST/PATCH/DELETE) carry
 * `X-Requested-With: ax-admin` so they pass the http-server's CSRF guard
 * regardless of how `allowedOrigins` is configured. Same posture as
 * `lib/auth.ts`.
 */
import type { AdminTeamWire } from '@ax/teams';
import { STORAGE_FULL_IDENTITY } from './storage-copy';
import { readStorageFull } from './storage-full';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

// Agents (admin scope) ---------------------------------------------------

export interface AdminAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  // TASK-142: no `systemPrompt` — an agent's identity lives in its `.ax/` files
  // (IDENTITY.md / SOUL.md / AGENTS.md), edited via the identity file editor
  // (getAgentIdentity / putAgentIdentity below), not this record.
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  requestedModel?: string;
  workspaceRef: string | null;
  skillAttachments: Array<{ skillId: string; credentialBindings: Record<string, string> }>;
  /** TASK-107 — the connector ids attached to this agent (the first-class
   *  per-agent connector-attachment store, replacing TASK-98's mcpConfigIds
   *  stopgap). Written by the workspace rail's attach/detach (TASK-799). */
  connectorAttachments: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminAgentInput {
  displayName: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  visibility: 'personal' | 'team';
  teamId?: string;
  workspaceRef?: string | null;
}

/**
 * The agent's identity files, read from / written to its `.ax/` directory via
 * the workspace hooks (TASK-142). `identity` ← `.ax/IDENTITY.md`, `soul` ←
 * `.ax/SOUL.md`, `operating` ← `.ax/AGENTS.md` (the optional advanced
 * operating-instructions override). Each is '' when the file is absent.
 */
export interface AgentIdentityFiles {
  identity: string;
  soul: string;
  operating: string;
}

/** GET the agent's `.ax/` identity files for the editor. */
export async function getAgentIdentity(id: string): Promise<AgentIdentityFiles> {
  const res = await fetch(`/admin/agents/${encodeURIComponent(id)}/identity`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`get agent identity: ${res.status}`);
  return (await res.json()) as AgentIdentityFiles;
}

/** PUT the agent's `.ax/` identity files (IDENTITY.md / SOUL.md / AGENTS.md).
 * The server writes through `workspace:apply` (→ validator-identity). `operating`
 * is created only when non-empty; clearing it deletes `.ax/AGENTS.md`.
 *
 * A 413 `storage-full` (the storage limit turned the save away, TASK-719) throws
 * a `StorageFullError`, whose `message` IS the sentence to show: no status, no
 * colon, no code. AgentForm prints `err.message`, so it needs no branch of its
 * own. Every other failure keeps its `save agent identity: <status>: <reason>`
 * shape (a validator's 400 carries the reason the person can act on). */
export async function putAgentIdentity(
  id: string,
  files: AgentIdentityFiles,
): Promise<void> {
  const path = `/admin/agents/${encodeURIComponent(id)}/identity`;
  const res = await fetch(path, {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(files),
  });
  if (!res.ok) {
    // `clone()`: looking for the refusal reads the body, and the detail below
    // reads it again for any failure that is not this one.
    const full = await readStorageFull(path, res.clone(), STORAGE_FULL_IDENTITY);
    if (full !== null) throw full;
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : '';
    } catch {
      // non-JSON body — fall through with the status only.
    }
    throw new Error(`save agent identity: ${res.status}${detail}`);
  }
}

/** One selectable model, as reported by `GET /admin/agents/models`. The list
 *  IS this deployment's agents allow-list — every id here is a valid agent
 *  `model` (`provider/model-id`) — decorated with the label and kind reported
 *  by whichever `models:list-supported:<provider>` registrants are loaded (an
 *  id no registrant covers falls back to `label === id`). An empty list means
 *  an empty allow-list — the caller must say so rather than render an empty
 *  picker. */
export interface AgentModelOption {
  id: string;
  label: string;
  kind: 'fast' | 'default' | 'either';
}

/** GET the models this deployment can actually assign to an agent. */
export interface AgentModelList {
  models: AgentModelOption[];
  /** The Default the admin chose; `null` when the server did not say (older host). */
  defaultModel: string | null;
}

export async function listAgentModelOptions(): Promise<AgentModelList> {
  const res = await fetch('/admin/agents/models', { credentials: 'include' });
  if (!res.ok) throw new Error(`list agent models: ${res.status}`);
  const body = (await res.json()) as { models?: AgentModelOption[]; defaultModel?: unknown };
  return {
    models: body.models ?? [],
    defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel : null,
  };
}

export async function listAgentModels(): Promise<AgentModelOption[]> {
  return (await listAgentModelOptions()).models;
}


export async function listAdminAgents(): Promise<AdminAgent[]> {
  const res = await fetch('/admin/agents', { credentials: 'include' });
  if (!res.ok) throw new Error(`list agents: ${res.status}`);
  const body = (await res.json()) as { agents: AdminAgent[] };
  return body.agents;
}

/** Read the agent as it will run, including a temporary model fallback. */
export async function getAdminAgent(id: string): Promise<AdminAgent> {
  const res = await fetch(`/admin/agents/${encodeURIComponent(id)}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`read agent: ${res.status}`);
  const body = (await res.json()) as { agent: AdminAgent };
  return body.agent;
}

export async function createAgent(input: AdminAgentInput): Promise<AdminAgent> {
  const res = await fetch('/admin/agents', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create agent: ${res.status}`);
  const body = (await res.json()) as { agent: AdminAgent };
  return body.agent;
}

export async function patchAgent(
  id: string,
  patch: Partial<AdminAgentInput>,
): Promise<void> {
  const res = await fetch(`/admin/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch agent: ${res.status}`);
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`/admin/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'ax-admin' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`delete agent: ${res.status}`);
}

export async function patchAgentSkillAttachments(
  agentId: string,
  skillAttachments: Array<{ skillId: string; credentialBindings: Record<string, string> }>,
): Promise<AdminAgent> {
  const res = await fetch(
    `/admin/agents/${encodeURIComponent(agentId)}/skill-attachments`,
    {
      method: 'PATCH',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ skillAttachments }),
    },
  );
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`patch skill attachments: ${res.status} ${excerpt.slice(0, 200)}`);
  }
  const out = (await res.json()) as { agent: AdminAgent };
  return out.agent;
}

// MCP servers ------------------------------------------------------------
// TASK-98 collapsed the standalone admin MCP-server surface into the
// connector registry (invariant #4 — one source of truth). The client
// wrappers that hit `/admin/mcp-servers` lived here; they're gone. An
// MCP-backed connector is now just a connector whose capabilities.mcpServers
// is non-empty, managed via `lib/connectors.ts` + `/admin/connectors`.
// Connectors reach an agent through `agent.connectorAttachments` (above),
// written by the workspace rail — not through `mcpConfigIds`.

// Authored skills --------------------------------------------------------
// E3: list the skills an agent has written in its workspace and promote
// one to an installed skill with admin-chosen capability grants.

export interface AuthoredSkill {
  id: string;
  description: string;
  version: number;
  bodyMd: string;
  hasForbiddenCapabilities: boolean;
}

export async function listAuthoredSkills(agentId: string): Promise<AuthoredSkill[]> {
  const res = await fetch(
    `/admin/agents/${encodeURIComponent(agentId)}/authored-skills`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    const msg = (() => {
      try {
        return (JSON.parse(excerpt) as { error?: string }).error ?? excerpt;
      } catch {
        return excerpt;
      }
    })();
    throw new Error(msg || `list authored-skills: ${res.status}`);
  }
  const body = (await res.json()) as { skills: AuthoredSkill[] };
  return body.skills;
}

export interface PromoteGrants {
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: 'api-key' }>;
  mcpServers: never[];
}

export async function promoteAuthoredSkill(
  agentId: string,
  body: { skillId: string; targetScope: 'global' | 'user'; grants: PromoteGrants },
): Promise<{ promoted: true; skillId: string; targetScope: string }> {
  const res = await fetch(
    `/admin/agents/${encodeURIComponent(agentId)}/authored-skills/promote`,
    {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    const msg = (() => {
      try {
        return (JSON.parse(excerpt) as { error?: string }).error ?? excerpt;
      } catch {
        return excerpt;
      }
    })();
    throw new Error(msg || `promote authored-skill: ${res.status}`);
  }
  return res.json() as Promise<{ promoted: true; skillId: string; targetScope: string }>;
}

/**
 * Delete an agent-authored draft (the Delete affordance on AuthoredSkillsSection).
 * Admin-only on the server; the server resolves the agent's owner and removes the
 * draft via @ax/skills' delete-authored hook. 204 on success (idempotent).
 */
export async function deleteAuthoredSkill(
  agentId: string,
  skillId: string,
): Promise<void> {
  const res = await fetch(
    `/admin/agents/${encodeURIComponent(agentId)}/authored-skills/${encodeURIComponent(skillId)}`,
    {
      method: 'DELETE',
      headers: { 'x-requested-with': 'ax-admin' },
      credentials: 'include',
    },
  );
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    const msg = (() => {
      try {
        return (JSON.parse(excerpt) as { error?: string }).error ?? excerpt;
      } catch {
        return excerpt;
      }
    })();
    throw new Error(msg || `delete authored-skill: ${res.status}`);
  }
}

// Teams ------------------------------------------------------------------
// Listing is all the SPA does today: TeamList shows the caller's teams and
// AgentForm populates its team-owner dropdown. `GET /admin/teams` answers
// "which teams am I in" (`teams:list-for-user`), not "every team".
//
// The element type is @ax/teams' own exported wire type (type-only import —
// invariant #2 allows those), so the route and this client cannot drift
// apart again (TASK-571: this used to be a mock-local `{ name, members }`
// that no server ever sent).

export type Team = AdminTeamWire;

export async function listTeams(): Promise<Team[]> {
  const res = await fetch('/admin/teams', { credentials: 'include' });
  if (!res.ok) throw new Error(`list teams: ${res.status}`);
  return (await res.json()).teams;
}
