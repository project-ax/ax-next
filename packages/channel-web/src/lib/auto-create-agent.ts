export interface CreatedAgent {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

/** A friendly placeholder name. The agent renames itself during bootstrap by
 * writing `.ax/IDENTITY.md`, so this is only what the sidebar shows until then. */
export const DEFAULT_NEW_AGENT_NAME = 'New agent';

/**
 * Create the caller's personal agent as a BARE agent (no system prompt) via the
 * first-run bootstrap route (TASK-140). The server seeds `.ax/BOOTSTRAP.md`, so
 * the new agent wakes up in bootstrap mode and discovers its identity through
 * conversation — there is no form. Mirrors the channel-web client convention:
 * `x-requested-with: ax-admin` (CSRF bypass header) + `credentials: 'include'`
 * on writes.
 */
export async function autoCreateBareAgent(
  displayName: string = DEFAULT_NEW_AGENT_NAME,
): Promise<CreatedAgent> {
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
