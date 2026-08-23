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
 * creating an agent (see NewAgentDialog) so the DB column is correct from the start.
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
