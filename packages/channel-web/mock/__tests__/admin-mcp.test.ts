import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import { adminMcpServersMiddleware, type McpServer } from '../admin/mcp-servers';

async function startServer(
  store: Store,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const adminMcp = adminMcpServersMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await adminMcp(req, res)) return;
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

const ADMIN = 'mock-session=u1';
const ALICE = 'mock-session=u2';

describe('mock admin mcp-servers', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-admin-mcp-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('admin lists mcp servers (empty by default)', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/mcp-servers`, { headers: { cookie: ADMIN } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.servers)).toBe(true);
      expect(body.servers).toEqual([]);
    } finally {
      await close();
    }
  });

  it('non-admin gets 403', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/mcp-servers`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it('admin POST creates mcp server and returns 201 + id', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/mcp-servers`, {
        method: 'POST',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'github',
          url: 'https://example.com/mcp',
          transport: 'http',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^mcp-[0-9a-z]+-[A-Za-z0-9_-]{6}$/);
      const stored = store.collection<McpServer>('mcp-servers').get(body.id);
      expect(stored).toMatchObject({ name: 'github', url: 'https://example.com/mcp', transport: 'http' });
    } finally {
      await close();
    }
  });

  it('admin PATCH updates mcp server', async () => {
    store
      .collection<McpServer>('mcp-servers')
      .upsert({ id: 'm1', name: 'old', url: 'https://x', transport: 'http', created_at: 1, updated_at: 2 });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/mcp-servers/m1`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new' }),
      });
      expect(res.status).toBe(200);
      const got = store.collection<McpServer>('mcp-servers').get('m1');
      expect(got?.name).toBe('new');
      expect(got?.url).toBe('https://x');
    } finally {
      await close();
    }
  });

  it('admin DELETE returns 204', async () => {
    store
      .collection<McpServer>('mcp-servers')
      .upsert({ id: 'm1', name: 'a', url: 'https://x', transport: 'http', created_at: 1, updated_at: 2 });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/mcp-servers/m1`, {
        method: 'DELETE',
        headers: { cookie: ADMIN },
      });
      expect(res.status).toBe(204);
      expect(store.collection<McpServer>('mcp-servers').get('m1')).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('admin POST :id/test returns { ok: true }', async () => {
    store
      .collection<McpServer>('mcp-servers')
      .upsert({ id: 'm1', name: 'a', url: 'https://x', transport: 'http', created_at: 1, updated_at: 2 });
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/mcp-servers/m1/test`, {
        method: 'POST',
        headers: { cookie: ADMIN },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    } finally {
      await close();
    }
  });
});
