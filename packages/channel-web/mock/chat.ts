import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Store } from './store';
import { requireSession, type User } from './auth';

export interface Session {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; fileId: string; mimeType?: string }
  | { type: 'file'; fileId: string; mimeType?: string; filename?: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; output: unknown };

export interface HistoryMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  created_at: number;
}

interface Agent {
  id: string;
  owner_id: string;
  owner_type: 'user' | 'team';
}

interface Team {
  id: string;
  name: string;
  members: string[];
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  res.statusCode = status;
  if (body === undefined) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('base64url').slice(0, 6);
  return `sess-${ts}-${rand}`;
}

function canUseAgent(user: User, agent: Agent, store: Store): boolean {
  if (agent.owner_type === 'user') return agent.owner_id === user.id;
  if (agent.owner_type === 'team') {
    const team = store.collection<Team>('teams').get(agent.owner_id);
    return !!team && team.members.includes(user.id);
  }
  return false;
}

export function chatMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/chat/')) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    // GET /api/chat/sessions — list caller's sessions
    if (path === '/api/chat/sessions' && method === 'GET') {
      const user = requireSession(req, store);
      if (!user) return send(res, 401, {}), true;
      const all = store.collection<Session>('sessions').list();
      const mine = all
        .filter((s) => s.user_id === user.id)
        .sort((a, b) => b.updated_at - a.updated_at);
      send(res, 200, { sessions: mine });
      return true;
    }

    // POST /api/chat/sessions — create session
    if (path === '/api/chat/sessions' && method === 'POST') {
      const user = requireSession(req, store);
      if (!user) return send(res, 401, {}), true;
      const body = (await readJsonBody(req)) as { agentId?: string };
      const agentId = body.agentId ?? '';
      const agent = store.collection<Agent>('agents').get(agentId);
      if (!agent || !canUseAgent(user, agent, store)) {
        send(res, 403, { error: 'forbidden' });
        return true;
      }
      const now = Date.now();
      const session: Session = {
        id: newSessionId(),
        user_id: user.id,
        agent_id: agent.id,
        title: 'new session',
        created_at: now,
        updated_at: now,
      };
      store.collection<Session>('sessions').upsert(session);
      send(res, 201, { id: session.id });
      return true;
    }

    // /api/chat/sessions/:id and /api/chat/sessions/:id/history
    const idMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)(\/history)?$/);
    if (idMatch && idMatch[1]) {
      const user = requireSession(req, store);
      if (!user) return send(res, 401, {}), true;
      const id: string = idMatch[1];
      const isHistory = !!idMatch[2];
      const sessions = store.collection<Session>('sessions');
      const session = sessions.get(id);

      // Tenant isolation: treat unknown id and other-user's id identically (403)
      // so attackers can't enumerate session IDs via 404-vs-403 discrimination.
      if (!session || session.user_id !== user.id) {
        send(res, 403, { error: 'forbidden' });
        return true;
      }

      if (isHistory && method === 'GET') {
        const all = store.collection<HistoryMessage>('messages').list();
        const messages = all
          .filter((m) => m.session_id === id)
          .sort((a, b) => a.created_at - b.created_at);
        send(res, 200, { messages });
        return true;
      }

      if (!isHistory && method === 'PATCH') {
        const body = (await readJsonBody(req)) as { title?: string };
        const next: Session = {
          ...session,
          title: typeof body.title === 'string' ? body.title : session.title,
          updated_at: Date.now(),
        };
        sessions.upsert(next);
        send(res, 200, {});
        return true;
      }

      if (!isHistory && method === 'DELETE') {
        sessions.remove(id);
        const messages = store.collection<HistoryMessage>('messages');
        for (const m of messages.list()) {
          if (m.session_id === id) messages.remove(m.id);
        }
        send(res, 204);
        return true;
      }
    }

    // TODO(Task 6): POST /api/chat/completions — SSE chat completions handler
    // lands here. Will reuse canUseAgent + create-session-if-missing flow.

    return false;
  };
}
