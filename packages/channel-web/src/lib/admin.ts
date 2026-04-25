/**
 * Admin client — typed wrappers around `/api/admin/*`.
 *
 * Used by `AdminPanel` (chrome) and the per-view forms — agents in
 * Task 22, MCP servers in Task 23, teams placeholder in Task 24. Routes
 * the `AdminView` type through here so `App.tsx` and `AdminPanel.tsx`
 * both import it from a neutral location and don't form an import cycle.
 *
 * SECURITY NOTE — every endpoint these helpers hit is guarded server-side
 * by the admin role check (mock: `mock/admin/*`, real backend in
 * Week 9.5). Hiding admin entries from non-admins in the UI is a
 * convenience; access control sits on the server.
 */
import type { Agent, AgentInput } from '../../mock/agents';
import type { McpServer } from '../../mock/admin/mcp-servers';
import type { Team } from '../../mock/admin/teams';

export type AdminView = 'agents' | 'mcp-servers' | 'teams' | null;

const headers = { 'content-type': 'application/json' };

// Agents (admin scope) ---------------------------------------------------

export async function listAdminAgents(): Promise<Agent[]> {
  const res = await fetch('/api/admin/agents', { credentials: 'include' });
  if (!res.ok) throw new Error(`list agents: ${res.status}`);
  const body = await res.json();
  return body.agents;
}

export async function createAgent(input: AgentInput): Promise<{ id: string }> {
  const res = await fetch('/api/admin/agents', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create agent: ${res.status}`);
  return res.json();
}

export async function patchAgent(
  id: string,
  patch: Partial<AgentInput>,
): Promise<void> {
  const res = await fetch(`/api/admin/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers,
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch agent: ${res.status}`);
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`/api/admin/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`delete agent: ${res.status}`);
}

// MCP servers ------------------------------------------------------------
// Task 23 wires create/patch/delete/test for the McpServerForm.
// `listMcpServers` is also called from AgentForm's chip-input placeholder.

export interface McpServerInput {
  name: string;
  url: string;
  transport: 'http' | 'stdio' | 'sse';
  credentials_id?: string;
}

export async function listMcpServers(): Promise<McpServer[]> {
  const res = await fetch('/api/admin/mcp-servers', { credentials: 'include' });
  if (!res.ok) throw new Error(`list mcp: ${res.status}`);
  return (await res.json()).servers;
}

export async function createMcpServer(
  input: McpServerInput,
): Promise<{ id: string }> {
  const res = await fetch('/api/admin/mcp-servers', {
    method: 'POST',
    headers,
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
    `/api/admin/mcp-servers/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers,
      credentials: 'include',
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`patch mcp: ${res.status}`);
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await fetch(
    `/api/admin/mcp-servers/${encodeURIComponent(id)}`,
    { method: 'DELETE', credentials: 'include' },
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
      `/api/admin/mcp-servers/${encodeURIComponent(id)}/test`,
      { method: 'POST', credentials: 'include' },
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
  const res = await fetch('/api/admin/teams', { credentials: 'include' });
  if (!res.ok) throw new Error(`list teams: ${res.status}`);
  return (await res.json()).teams;
}
