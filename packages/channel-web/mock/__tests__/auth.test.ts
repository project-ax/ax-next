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

describe('mock auth (mirrors @ax/auth-oidc wire surface)', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-auth-'));
    store = new Store(dir);
    store.seed();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns 401 on /admin/me when no cookie present', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/me`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('completes the synthetic OAuth flow and returns the user on /admin/me', async () => {
    const { server, url } = await startServer(store);
    try {
      // Step 1: GET /auth/sign-in/google → 302 to mock callback
      const signin = await fetch(`${url}/auth/sign-in/google`, { redirect: 'manual' });
      expect(signin.status).toBe(302);
      const callbackPath = signin.headers.get('location');
      expect(callbackPath).toMatch(/^\/auth\/mock\/google-callback\?user=u2/);

      // Step 2: GET callback → 302 to /, capture cookie
      const cb = await fetch(`${url}${callbackPath}`, { redirect: 'manual' });
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location')).toBe('/');
      const setCookie = cb.headers.get('set-cookie');
      expect(setCookie).toMatch(/^mock-session=u2/);

      // Step 3: GET /admin/me with cookie returns the BackendUser shape
      const session = await fetch(`${url}/admin/me`, {
        headers: { cookie: 'mock-session=u2' },
      });
      expect(session.status).toBe(200);
      const body = await session.json();
      expect(body.user).toMatchObject({
        id: 'u2',
        email: 'alice@local',
        displayName: 'Alice',
        isAdmin: false,
      });
    } finally {
      server.close();
    }
  });

  it('respects ?user=<id> on /auth/sign-in/google for admin testing', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/auth/sign-in/google?user=u1`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/user=u1$/);
    } finally {
      server.close();
    }
  });

  it('returns 400 on /auth/mock/google-callback for unknown user', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/auth/mock/google-callback?user=ghost`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('clears the cookie on POST /admin/sign-out (CSRF-gated)', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/sign-out`, {
        method: 'POST',
        headers: { 'x-requested-with': 'ax-admin' },
      });
      expect(res.status).toBe(204);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toMatch(/mock-session=;/);
      expect(setCookie).toMatch(/Max-Age=0/);
    } finally {
      server.close();
    }
  });

  it('rejects POST /admin/sign-out without X-Requested-With (CSRF)', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/sign-out`, { method: 'POST' });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'csrf-failed' });
    } finally {
      server.close();
    }
  });

  it('returns 410 Gone on legacy /api/auth/* paths', async () => {
    const { server, url } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/auth/get-session`);
      expect(res.status).toBe(410);
    } finally {
      server.close();
    }
  });
});
