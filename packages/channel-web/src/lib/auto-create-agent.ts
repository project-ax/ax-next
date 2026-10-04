export interface CreatedAgent {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

/**
 * Create the caller's personal agent as a BARE agent (no system prompt) via the
 * first-run bootstrap route (TASK-140). The server seeds `.ax/BOOTSTRAP.md`, so
 * the new agent wakes up in bootstrap mode and discovers its identity through
 * conversation — there is no form. Mirrors the channel-web client convention:
 * `x-requested-with: ax-admin` (CSRF bypass header) + `credentials: 'include'`
 * on writes.
 *
 * `displayName` is required — callers must collect a name from the user before
 * creating an agent (see NewAgentCard) so the DB column is correct from the start.
 */
import { HttpError, httpFetch } from './http';

export async function autoCreateBareAgent(displayName: string): Promise<CreatedAgent> {
  // Through `lib/http.ts` (TASK-288). `FirstRunAutoCreate` catches this with a
  // bare `catch {}`, so on a dead session the first-run flow would otherwise
  // just quietly not create an agent. The latch fires on the response, before
  // that catch can swallow anything.
  const res = await httpFetch('/api/agents/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    throw new HttpError('/api/agents/bootstrap', res.status);
  }
  const body = (await res.json()) as { agent: CreatedAgent };
  return body.agent;
}

/*
  TASK-791 — the two ways out of a create whose agent ALREADY EXISTS.

  Both use the ordinary agent routes (`PATCH` / `DELETE /admin/agents/:id`),
  so the server's `agents:update` / `agents:delete` run their ownership check
  and a delete fires `agents:deleted` for every per-agent cleanup subscriber.
  Through `lib/http.ts` rather than `lib/admin.ts`'s raw-`fetch` twins for the
  same reason as the create above: a dead session must trip the 401 latch.

  Callers pass ONLY the id this flow's own bootstrap POST returned — never an
  id picked from a list.
*/
const agentPath = (agentId: string): string => `/admin/agents/${encodeURIComponent(agentId)}`;

/** Give the agent this flow already created the name the person just typed. */
export async function renameCreatedAgent(agentId: string, displayName: string): Promise<void> {
  const path = agentPath(agentId);
  const res = await httpFetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new HttpError(path, res.status);
}

/** Remove the half-made agent this flow created, so Cancel leaves nothing behind. */
export async function discardCreatedAgent(agentId: string): Promise<void> {
  const path = agentPath(agentId);
  const res = await httpFetch(path, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'ax-admin' },
  });
  // 404 means it is already gone, which is all Cancel wanted.
  if (!res.ok && res.status !== 404) throw new HttpError(path, res.status);
}
