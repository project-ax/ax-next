import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import { adminAgentsMiddleware } from '../admin/agents';
import type { Agent } from '../agents';

async function startServer(
  store: Store,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const adminAgents = adminAgentsMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await adminAgents(req, res)) return;
    res.statusCode = 404;
    res.end();
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

describe('mock admin agents', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-admin-agents-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('admin lists ALL agents', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/agents`, { headers: { cookie: ADMIN } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = (body.agents as Agent[]).map((a) => a.id).sort();
      expect(ids).toEqual(['mercy', 'team-engineering', 'tide']);
    } finally {
      await close();
    }
  });

  it('non-admin gets 403', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/agents`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it('admin POST creates an agent and returns 201 + id', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/agents`, {
        method: 'POST',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_id: 'u1',
          owner_type: 'user',
          name: 'newbie',
          tag: 'misc',
          desc: 'a new agent',
          color: '#abcdef',
          system_prompt: 'do things',
          allowed_tools: [],
          mcp_config_ids: [],
          model: 'claude-sonnet-4-6',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^agent-[0-9a-z]+-[A-Za-z0-9_-]{6}$/);
      const stored = store.collection<Agent>('agents').get(body.id);
      expect(stored).toMatchObject({ name: 'newbie', owner_id: 'u1', owner_type: 'user' });
      expect(typeof stored?.created_at).toBe('number');
      expect(stored?.created_at).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('admin PATCH partially updates an agent', async () => {
    const { url, close } = await startServer(store);
    try {
      const before = store.collection<Agent>('agents').get('tide');
      expect(before).toBeTruthy();
      const res = await fetch(`${url}/api/admin/agents/tide`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ desc: 'updated description' }),
      });
      expect(res.status).toBe(200);
      const after = store.collection<Agent>('agents').get('tide');
      expect(after?.desc).toBe('updated description');
      expect(after?.name).toBe('tide');
      expect((after?.updated_at ?? 0)).toBeGreaterThan(before?.updated_at ?? 0);
    } finally {
      await close();
    }
  });

  it('admin PATCH 404 on unknown id', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/agents/no-such`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ desc: 'x' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('admin DELETE returns 204 and removes the agent', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/agents/mercy`, {
        method: 'DELETE',
        headers: { cookie: ADMIN },
      });
      expect(res.status).toBe(204);
      expect(store.collection<Agent>('agents').get('mercy')).toBeUndefined();
    } finally {
      await close();
    }
  });
});
