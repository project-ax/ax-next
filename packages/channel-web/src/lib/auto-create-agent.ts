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
export async function autoCreateBareAgent(displayName: string): Promise<CreatedAgent> {
  const res = await fetch('/api/agents/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    throw new Error(`auto-create agent: ${res.status}`);
  }
  const body = (await res.json()) as { agent: CreatedAgent };
  return body.agent;
}
