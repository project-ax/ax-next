import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMockHandler } from '../server';

async function start(handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('mock server router', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mock-server-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('routes /api/auth/get-session, /api/agents, and /api/admin/agents through the right handlers', async () => {
    const handler = createMockHandler(dir);
    const { url, close } = await start(handler);
    try {
      // Anonymous → 401
      let res = await fetch(`${url}/api/auth/get-session`);
      expect(res.status).toBe(401);

      // Sign in as Alice via callback shortcut
      res = await fetch(`${url}/api/auth/callback?user=u2`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const cookie = res.headers.get('set-cookie')!.split(';')[0]!;

      // /api/agents returns Alice's accessible agents
      res = await fetch(`${url}/api/agents`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.agents)).toBe(true);

      // /api/admin/agents → 403 for non-admin
      res = await fetch(`${url}/api/admin/agents`, { headers: { cookie } });
      expect(res.status).toBe(403);

      // /api/random/path falls through to 404
      res = await fetch(`${url}/api/random/path`, { headers: { cookie } });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });
});
