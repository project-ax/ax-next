import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import { chatMiddleware } from '../chat';

async function startServer(store: Store): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const chat = chatMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await chat(req, res)) return;
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const ALICE = 'mock-session=u2';
const ADMIN = 'mock-session=u1';

describe('mock sessions', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-sessions-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists only the caller's sessions", async () => {
    const { url, close } = await startServer(store);
    try {
      // Seed one session for each user directly via the store
      store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'sess-alice', user_id: 'u2', agent_id: 'tide', title: 'a', created_at: 1, updated_at: 2 });
      store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'sess-admin', user_id: 'u1', agent_id: 'tide', title: 'b', created_at: 3, updated_at: 4 });
      const res = await fetch(`${url}/api/chat/sessions`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['sess-alice']);
    } finally { await close(); }
  });

  it('creates a session 201 with id', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/sessions`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'tide' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^sess-/);
      const all = store.collection<{ id: string; user_id: string }>('sessions').list();
      expect(all.find((s) => s.id === body.id)).toMatchObject({ user_id: 'u2', agent_id: 'tide' });
    } finally { await close(); }
  });

  it("rejects creating a session with another user's personal agent (403)", async () => {
    // Add a personal agent owned by Alice
    store.collection<{ id: string; owner_id: string; owner_type: 'user' | 'team' }>('agents').upsert({ id: 'alice-agent', owner_id: 'u2', owner_type: 'user' });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/sessions`, {
        method: 'POST',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'alice-agent' }),
      });
      expect(res.status).toBe(403);
    } finally { await close(); }
  });

  it('renames a session', async () => {
    store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'sess-alice', user_id: 'u2', agent_id: 'tide', title: 'old', created_at: 1, updated_at: 2 });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/sessions/sess-alice`, {
        method: 'PATCH',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'new title' }),
      });
      expect(res.status).toBe(200);
      const got = store.collection<{ id: string; title: string }>('sessions').get('sess-alice');
      expect(got?.title).toBe('new title');
    } finally { await close(); }
  });

  it('deletes a session and its messages (204)', async () => {
    store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'sess-alice', user_id: 'u2', agent_id: 'tide', title: 't', created_at: 1, updated_at: 1 });
    store.collection<{ id: string; session_id: string }>('messages').upsert({ id: 'm1', session_id: 'sess-alice' });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/sessions/sess-alice`, {
        method: 'DELETE', headers: { cookie: ALICE },
      });
      expect(res.status).toBe(204);
      expect(store.collection<{ id: string }>('sessions').get('sess-alice')).toBeUndefined();
      expect(store.collection<{ id: string; session_id: string }>('messages').list().filter((m) => m.session_id === 'sess-alice')).toHaveLength(0);
    } finally { await close(); }
  });

  it('rejects cross-tenant history fetch (403)', async () => {
    store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'sess-alice', user_id: 'u2', agent_id: 'tide', title: 't', created_at: 1, updated_at: 1 });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/sessions/sess-alice/history`, { headers: { cookie: ADMIN } });
      expect(res.status).toBe(403);
    } finally { await close(); }
  });

  it('returns history messages for the owner', async () => {
    store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'sess-alice', user_id: 'u2', agent_id: 'tide', title: 't', created_at: 1, updated_at: 1 });
    store.collection<{ id: string; session_id: string; role: string; content: string; created_at: number }>('messages').upsert({ id: 'm1', session_id: 'sess-alice', role: 'user', content: 'hi', created_at: 1 });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/sessions/sess-alice/history`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    } finally { await close(); }
  });
});
