/**
 * Agent-list wire client — the user-scoped list behind the Settings agent
 * switcher (TASK-42). Mirrors `lib/credentials.ts`'s posture:
 * `credentials: 'include'` so the auth-better cookie rides along; the server
 * derives identity from the cookie (never trusts a client-supplied user id).
 *
 * Wraps `GET /api/chat/agents`, which channel-web already serves (the AgentMenu
 * consumes the same route).
 */
import { httpJson } from './http';

export interface ChatAgentSummary {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

export async function listChatAgents(): Promise<ChatAgentSummary[]> {
  // Through `lib/http.ts` (TASK-288): a 401 here ends the session instead of
  // becoming the string `list agents: 401` on somebody's screen.
  return httpJson<ChatAgentSummary[]>('/api/chat/agents');
}
