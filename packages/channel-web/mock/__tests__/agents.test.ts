import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import { agentsMiddleware, type Agent } from '../agents';

async function startServer(
  store: Store,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const agents = agentsMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await agents(req, res)) return;
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

describe('mock user-scoped agents', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-agents-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('admin sees personal + team agents (mercy + tide + team-engineering)', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/agents`, { headers: { cookie: ADMIN } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = (body.agents as Agent[]).map((a) => a.id);
      expect(ids).toContain('mercy');
      expect(ids).toContain('tide');
      expect(ids).toContain('team-engineering');
    } finally {
      await close();
    }
  });

  it("Alice sees team agents but not Admin's personal mercy", async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/agents`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = (body.agents as Agent[]).map((a) => a.id);
      expect(ids).toContain('tide');
      expect(ids).toContain('team-engineering');
      expect(ids).not.toContain('mercy');
    } finally {
      await close();
    }
  });

  it('returns agents sorted by name ascending', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/agents`, { headers: { cookie: ADMIN } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const names = (body.agents as Agent[]).map((a) => a.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    } finally {
      await close();
    }
  });

  it('unauthenticated request gets 401', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/agents`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});
