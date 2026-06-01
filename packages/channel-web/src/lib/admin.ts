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
 * `lib/auth.ts` and `components/SessionRow.tsx`.
 */
import type { Team } from '../../mock/admin/teams';

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
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  skillAttachments: Array<{ skillId: string; credentialBindings: Record<string, string> }>;
  /** TASK-107 — the connector ids attached to this agent (the first-class
   *  per-agent connector-attachment store, replacing TASK-98's mcpConfigIds
   *  stopgap). Written via PATCH /admin/agents/:id/connector-attachments. */
  connectorAttachments: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminAgentInput {
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  visibility: 'personal' | 'team';
  teamId?: string;
  workspaceRef?: string | null;
}

export async function listAdminAgents(): Promise<AdminAgent[]> {
  const res = await fetch('/admin/agents', { credentials: 'include' });
  if (!res.ok) throw new Error(`list agents: ${res.status}`);
  const body = (await res.json()) as { agents: AdminAgent[] };
  return body.agents;
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

/**
 * TASK-107 — replace the agent's connector attachments wholesale. PATCHes the
 * first-class per-agent connector-attachment store (NOT `mcpConfigIds`, which
 * reverts to MCP-only meaning). An empty list detaches all connectors. Mirrors
 * `patchAgentSkillAttachments`.
 */
export async function patchAgentConnectorAttachments(
  agentId: string,
  connectorAttachments: string[],
): Promise<AdminAgent> {
  const res = await fetch(
    `/admin/agents/${encodeURIComponent(agentId)}/connector-attachments`,
    {
      method: 'PATCH',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ connectorAttachments }),
    },
  );
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`patch connector attachments: ${res.status} ${excerpt.slice(0, 200)}`);
  }
  const out = (await res.json()) as { agent: AdminAgent };
  return out.agent;
}

// MCP servers ------------------------------------------------------------
// TASK-98 collapsed the standalone admin MCP-server surface into the
// connector registry (invariant #4 — one source of truth). The client
// wrappers that hit `/admin/mcp-servers` lived here; they're gone. An
// MCP-backed connector is now just a connector whose capabilities.mcpServers
// is non-empty, managed via `lib/connectors.ts` + `/admin/connectors`. The
// agent↔MCP binding still flows through `agent.mcpConfigIds` (above) — the
// AgentForm connector picker writes connector ids into it.

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
// Task 24 swaps the placeholder for a real list/edit panel. Listing today
// is enough so AgentForm can populate the team-owner dropdown.

export async function listTeams(): Promise<Team[]> {
  const res = await fetch('/admin/teams', { credentials: 'include' });
  if (!res.ok) throw new Error(`list teams: ${res.status}`);
  return (await res.json()).teams;
}
