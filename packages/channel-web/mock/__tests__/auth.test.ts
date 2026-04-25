import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';

async function startServer(store: Store): Promise<{ server: Server; url: string }> {
  const mw = authMiddleware(store);
  const server = createServer(async (req, res) => {
    const handled = await mw(req, res);
    if (!handled) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('mock auth', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-auth-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns 401 when no cookie present', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/auth/get-session`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('completes the synthetic OAuth flow and returns the user on get-session', async () => {
    const { server, url } = await startServer(store);
    try {
      // Step 1: sign-in returns a callback URL
      const signin = await fetch(`${url}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google' }),
      });
      expect(signin.status).toBe(200);
      const { url: callbackPath } = await signin.json();
      expect(callbackPath).toMatch(/^\/api\/auth\/callback\?user=u2/);

      // Step 2: hit callback, capture cookie
      const cb = await fetch(`${url}${callbackPath}`, { redirect: 'manual' });
      expect(cb.status).toBe(302);
      const setCookie = cb.headers.get('set-cookie');
      expect(setCookie).toMatch(/^mock-session=u2/);

      // Step 3: get-session with cookie returns the user
      const session = await fetch(`${url}/api/auth/get-session`, {
        headers: { cookie: 'mock-session=u2' },
      });
      expect(session.status).toBe(200);
      const body = await session.json();
      expect(body.user).toMatchObject({ id: 'u2', email: 'alice@local', role: 'user' });
    } finally {
      server.close();
    }
  });

  it('clears the cookie on sign-out', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/auth/sign-out`, { method: 'POST' });
      expect(res.status).toBe(204);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toMatch(/mock-session=;/);
      expect(setCookie).toMatch(/Max-Age=0/);
    } finally {
      server.close();
    }
  });
});
