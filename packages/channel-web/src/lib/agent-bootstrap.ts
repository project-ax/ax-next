export interface BootstrappedAgent {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

/**
 * Create the caller's personal agent via the first-run bootstrap route.
 * Mirrors the channel-web client convention: `x-requested-with: ax-admin`
 * (CSRF bypass header) + `credentials: 'include'` on writes.
 */
export async function bootstrapAgent(input: {
  displayName: string;
  systemPrompt: string;
}): Promise<BootstrappedAgent> {
  const res = await fetch('/api/agents/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`bootstrap agent: ${res.status}`);
  }
  const body = (await res.json()) as { agent: BootstrappedAgent };
  return body.agent;
}
