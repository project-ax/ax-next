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
import type { McpServer } from '../../mock/admin/mcp-servers';
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

// MCP servers ------------------------------------------------------------
// Task 23 wires create/patch/delete/test for the McpServerForm.
// `listMcpServers` is also called from AgentForm's chip-input placeholder.

export interface McpServerInput {
  name: string;
  transport: 'http' | 'stdio' | 'sse' | 'streamable-http';
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  credentialRefs?: Record<string, string>;
  // http/sse/streamable-http fields
  url?: string;
  headerCredentialRefs?: Record<string, string>;
}

export async function listMcpServers(): Promise<McpServer[]> {
  const res = await fetch('/admin/mcp-servers', { credentials: 'include' });
  if (!res.ok) throw new Error(`list mcp: ${res.status}`);
  return (await res.json()).servers;
}

export async function createMcpServer(
  input: McpServerInput,
): Promise<{ id: string }> {
  const res = await fetch('/admin/mcp-servers', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create mcp: ${res.status}`);
  return res.json();
}

export async function patchMcpServer(
  id: string,
  patch: Partial<McpServerInput>,
): Promise<void> {
  const res = await fetch(
    `/admin/mcp-servers/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`patch mcp: ${res.status}`);
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await fetch(
    `/admin/mcp-servers/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { 'x-requested-with': 'ax-admin' },
      credentials: 'include',
    },
  );
  if (!res.ok) throw new Error(`delete mcp: ${res.status}`);
}

// `testMcpServer` is unusual: it doesn't throw on HTTP failure — it folds
// the error into the returned shape. The Test button surfaces ok/error
// inline, and a thrown error would just become an unhandled rejection.
export async function testMcpServer(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `/admin/mcp-servers/${encodeURIComponent(id)}/test`,
      {
        method: 'POST',
        headers: { 'x-requested-with': 'ax-admin' },
        credentials: 'include',
      },
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
