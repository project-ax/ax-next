/**
 * Agent-list wire client — the user-scoped list behind the Settings agent
 * switcher (TASK-42). Mirrors `lib/credentials.ts`'s posture:
 * `credentials: 'include'` so the auth-better cookie rides along; the server
 * derives identity from the cookie (never trusts a client-supplied user id).
 *
 * Wraps `GET /api/chat/agents`, which channel-web already serves (the AgentMenu
 * consumes the same route).
 */
export interface ChatAgentSummary {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

export async function listChatAgents(): Promise<ChatAgentSummary[]> {
  const res = await fetch('/api/chat/agents', { credentials: 'include' });
  if (!res.ok) throw new Error(`list agents: ${res.status}`);
  return (await res.json()) as ChatAgentSummary[];
}
