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

    // POST /api/chat/completions — SSE chat completions
    if (path === '/api/chat/completions' && method === 'POST') {
      const user = requireSession(req, store);
      if (!user) return send(res, 401, {}), true;

      const body = (await readJsonBody(req)) as {
        model?: string;
        stream?: boolean;
        user?: string;
        messages?: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
      };

      const userField = typeof body.user === 'string' ? body.user : '';
      const slash = userField.indexOf('/');
      if (slash <= 0) {
        send(res, 400, { error: 'invalid user field' });
        return true;
      }
      const userId = userField.slice(0, slash);
      const threadId = userField.slice(slash + 1);
      if (!threadId) {
        send(res, 400, { error: 'invalid user field' });
        return true;
      }

      // Cookie owner must match the userId encoded in the user field.
      // Prevents Alice from posting to Admin's threads.
      if (userId !== user.id) {
        send(res, 403, { error: 'forbidden' });
        return true;
      }

      const sessionId = `${userId}:${threadId}`;
      const sessions = store.collection<Session>('sessions');
      let session = sessions.get(sessionId);

      // Create-if-missing: pick the first agent the user can use, sorted by id.
      if (!session) {
        const allAgents = store.collection<Agent>('agents').list();
        const usable = allAgents
          .filter((a) => canUseAgent(user, a, store))
          .sort((a, b) => a.id.localeCompare(b.id));
        const defaultAgent = usable[0];
        if (!defaultAgent) {
          send(res, 403, { error: 'no usable agent' });
          return true;
        }
        const now = Date.now();
        session = {
          id: sessionId,
          user_id: user.id,
          agent_id: defaultAgent.id,
          title: 'new session',
          created_at: now,
          updated_at: now,
        };
        sessions.upsert(session);
      } else if (session.user_id !== user.id) {
        // Defense-in-depth: shouldn't happen given userId check above,
        // but treat any owner mismatch as 403.
        send(res, 403, { error: 'forbidden' });
        return true;
      }

      const inMessages = Array.isArray(body.messages) ? body.messages : [];
      const messagesCol = store.collection<HistoryMessage>('messages');

      // Edit/retry truncation: if client sends a shorter array than persisted,
      // drop persisted entries beyond the new length BEFORE appending the new turn.
      const persistedForSession = messagesCol
        .list()
        .filter((m) => m.session_id === sessionId)
        .sort((a, b) => {
          // Order by suffix index when ids follow `${sessionId}:${i}`.
          const ai = Number(a.id.slice(sessionId.length + 1));
          const bi = Number(b.id.slice(sessionId.length + 1));
          if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
          return a.created_at - b.created_at;
        });
      const targetPriorCount = Math.max(0, inMessages.length - 1);
      if (persistedForSession.length > targetPriorCount) {
        for (let i = targetPriorCount; i < persistedForSession.length; i++) {
          const row = persistedForSession[i];
          if (row) messagesCol.remove(row.id);
        }
        persistedForSession.length = targetPriorCount;
      }

      // Append the new (last) user turn.
      const lastIn = inMessages[inMessages.length - 1];
      if (!lastIn || lastIn.role !== 'user') {
        send(res, 400, { error: 'last message must be a user turn' });
        return true;
      }
      const userIndex = persistedForSession.length;
      const userTurn: HistoryMessage = {
        id: `${sessionId}:${userIndex}`,
        session_id: sessionId,
        role: 'user',
        content: lastIn.content,
        created_at: Date.now(),
      };
      messagesCol.upsert(userTurn);

      // Auto-derive title on first user turn.
      const userText = extractText(lastIn.content);
      if (session.title === 'new session') {
        const slug = userText.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (slug.length > 0) {
          session = { ...session, title: slug, updated_at: Date.now() };
          sessions.upsert(session);
        }
      }

      // Stream the reply.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const reply = `(mock) You said: "${userText.slice(0, 200)}"`;
      const cancelled = { value: false };

      try {
        await streamReply(req, res, reply, cancelled);
      } catch {
        // Stream errors (write after close, etc.) — bail without persisting.
        return true;
      }

      if (cancelled.value) {
        // Client disconnected mid-stream; don't persist a partial assistant turn.
        return true;
      }

      const assistantTurn: HistoryMessage = {
        id: `${sessionId}:${userIndex + 1}`,
        session_id: sessionId,
        role: 'assistant',
        content: reply,
        created_at: Date.now(),
      };
      messagesCol.upsert(assistantTurn);
      sessions.upsert({ ...session, updated_at: Date.now() });
      return true;
    }

    return false;
  };
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

async function streamReply(
  req: IncomingMessage,
  res: ServerResponse,
  text: string,
  cancelled: { value: boolean },
): Promise<void> {
  // status: planning…
  res.write('event: status\n');
  res.write(
    `data: ${JSON.stringify({ operation: 'plan', phase: 'start', message: 'planning…' })}\n\n`,
  );

  let timer: NodeJS.Timeout | undefined;
  const onClose = (): void => {
    cancelled.value = true;
    if (timer) clearTimeout(timer);
  };
  req.on('close', onClose);

  try {
    // 30%-of-turns diagnostic, emitted right after the first content chunk.
    const wantDiagnostic = Math.random() < 0.3;
    let diagnosticEmitted = false;

    for (let i = 0; i < text.length; i++) {
      if (cancelled.value || res.writableEnded) return;
      const ch = text[i];
      const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`;
      res.write(chunk);

      if (i === 0 && wantDiagnostic && !diagnosticEmitted) {
        diagnosticEmitted = true;
        res.write('event: diagnostic\n');
        res.write(
          `data: ${JSON.stringify({
            severity: 'info',
            kind: 'mock_note',
            message: 'this is a mocked response',
            timestamp: new Date().toISOString(),
          })}\n\n`,
        );
      }

      // 12ms tick between chunks
      await new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          resolve();
        }, 12);
      });
    }

    if (cancelled.value || res.writableEnded) return;

    res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    req.off('close', onClose);
    if (timer) clearTimeout(timer);
  }
}
