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
  // TASK-142: no `systemPrompt` — an agent's identity and soul are `@ax/agents`
  // rows, edited via the identity editor (getAgentIdentity / putAgentIdentity
  // below), not this record.
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
 * An agent's identity (who it is) and soul (its values and the boundaries it
 * holds). Both are rows owned by `@ax/agents` (TASK-989); each is '' when the
 * agent has none yet. The people's Instructions are not here — they are edited
 * on the agent's settings page.
 */
export interface AgentIdentity {
  identity: string;
  soul: string;
}

/** GET the agent's identity and soul for the editor. A 503 (no identity store,
 * or the read failed) rejects, so the form never shows two blank fields over
 * text it could not read. */
export async function getAgentIdentity(id: string): Promise<AgentIdentity> {
  const res = await fetch(`/admin/agents/${encodeURIComponent(id)}/identity`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`get agent identity: ${res.status}`);
  return (await res.json()) as AgentIdentity;
}

/** PUT the agent's identity and soul. The server scans both before saving
 * (prompt-injection, credential-exfiltration and hidden-character checks).
 *
 * A 400 means the text itself was turned away: the server's `error` is a whole
 * sentence for the person ("…so nothing was saved: …"), and it IS the message,
 * so AgentForm prints `err.message` with no branch of its own. Every other
 * failure keeps its `save agent identity: <status>: <reason>` shape. */
export async function putAgentIdentity(id: string, identity: AgentIdentity): Promise<void> {
  const res = await fetch(`/admin/agents/${encodeURIComponent(id)}/identity`, {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ identity: identity.identity, soul: identity.soul }),
  });
  if (!res.ok) {
    let reason = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') reason = body.error;
    } catch {
      // non-JSON body — fall through with the status only.
    }
    if (res.status === 400 && reason !== '') throw new Error(reason);
    throw new Error(`save agent identity: ${res.status}${reason ? `: ${reason}` : ''}`);
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
// wrappers that hit `/admin/mcp-servers` lived here; they're gone, and the
// `/admin/mcp-servers` routes themselves were retired too (TASK-792). An
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
