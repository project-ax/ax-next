import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import { adminTeamsMiddleware, type Team } from '../admin/teams';

async function startServer(
  store: Store,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const adminTeams = adminTeamsMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await adminTeams(req, res)) return;
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

describe('mock admin teams', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-admin-teams-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('admin lists seeded teams', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/teams`, { headers: { cookie: ADMIN } });
      expect(res.status).toBe(200);
      const body = await res.json();
      const teams = body.teams as Team[];
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({ id: 't1', name: 'Engineering', members: ['u1', 'u2'] });
    } finally {
      await close();
    }
  });

  it('non-admin gets 403', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/admin/teams`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });
});
