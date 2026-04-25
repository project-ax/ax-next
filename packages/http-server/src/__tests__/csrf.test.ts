import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin, type HttpServerPlugin } from '../plugin.js';
import { evaluateCsrf } from '../csrf.js';

const COOKIE_KEY = randomBytes(32);
const ALLOWED = ['https://app.example.com', 'http://localhost:3000'];

describe('csrf — pure decision function', () => {
  it('passes GET / HEAD / OPTIONS unconditionally', () => {
    expect(evaluateCsrf('GET', {}, { allowedOrigins: ALLOWED })).toBeNull();
    expect(evaluateCsrf('HEAD', {}, { allowedOrigins: ALLOWED })).toBeNull();
    expect(evaluateCsrf('OPTIONS', {}, { allowedOrigins: ALLOWED })).toBeNull();
  });

  it('rejects POST without origin or bypass', () => {
    const r = evaluateCsrf('POST', {}, { allowedOrigins: ALLOWED });
    expect(r).not.toBeNull();
    expect(r?.reason).toBe('csrf-failed:origin-missing');
  });

  it('rejects POST with foreign origin', () => {
    const r = evaluateCsrf(
      'POST',
      { origin: 'https://evil.example.org' },
      { allowedOrigins: ALLOWED },
    );
    expect(r?.reason).toBe('csrf-failed:origin-mismatch');
  });

  it('passes POST with allowed origin', () => {
    expect(
      evaluateCsrf(
        'POST',
        { origin: 'https://app.example.com' },
        { allowedOrigins: ALLOWED },
      ),
    ).toBeNull();
  });

  it('passes POST with X-Requested-With: ax-admin (no origin needed)', () => {
    expect(
      evaluateCsrf(
        'POST',
        { 'x-requested-with': 'ax-admin' },
        { allowedOrigins: [] },
      ),
    ).toBeNull();
  });

  it('rejects POST with wrong X-Requested-With value', () => {
    const r = evaluateCsrf(
      'POST',
      { 'x-requested-with': 'XMLHttpRequest' },
      { allowedOrigins: ALLOWED },
    );
    expect(r?.reason).toBe('csrf-failed:origin-missing');
  });

  it('PUT/PATCH/DELETE all guarded same as POST', () => {
    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        evaluateCsrf(m, {}, { allowedOrigins: ALLOWED }),
      ).not.toBeNull();
      expect(
        evaluateCsrf(
          m,
          { origin: 'https://app.example.com' },
          { allowedOrigins: ALLOWED },
        ),
      ).toBeNull();
    }
  });

  it('exact-match origin: trailing slash is a mismatch', () => {
    const r = evaluateCsrf(
      'POST',
      { origin: 'https://app.example.com/' },
      { allowedOrigins: ALLOWED },
    );
    expect(r?.reason).toBe('csrf-failed:origin-mismatch');
  });
});

describe('csrf — wired through @ax/http-server', () => {
  let harness: TestHarness;
  let plugin: HttpServerPlugin;
  let port: number;

  beforeEach(async () => {
    plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: ALLOWED,
    });
    harness = await createTestHarness({ plugins: [plugin] });
    port = plugin.boundPort();
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'POST',
      path: '/protected',
      handler: async (_req, res) => {
        res.status(200).json({ ran: true });
      },
    });
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'PUT',
      path: '/protected',
      handler: async (_req, res) => {
        res.status(200).json({ ran: true });
      },
    });
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'PATCH',
      path: '/protected',
      handler: async (_req, res) => {
        res.status(200).json({ ran: true });
      },
    });
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'DELETE',
      path: '/protected',
      handler: async (_req, res) => {
        res.status(200).json({ ran: true });
      },
    });
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/safe',
      handler: async (_req, res) => {
        res.status(200).text('ok');
      },
    });
  });

  afterEach(async () => {
    await harness.close({ onError: () => {} });
  });

  it('POST without origin or bypass → 403', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'csrf-failed:origin-missing' });
  });

  it('POST with foreign origin → 403', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.org',
      },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'csrf-failed:origin-mismatch' });
  });

  it('POST with allowed origin → handler runs', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example.com',
      },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ran: true });
  });

  it('POST with X-Requested-With: ax-admin → handler runs (no origin)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/protected`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ran: true });
  });

  it('GET passes through with no origin', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/safe`);
    expect(r.status).toBe(200);
  });

  it('OPTIONS passes through (405 from router, not 403 from CSRF)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/safe`, {
      method: 'OPTIONS',
    });
    // The router rejects OPTIONS (405) — but it MUST NOT be a 403, that
    // would mean CSRF fired on a safe-method request.
    expect(r.status).not.toBe(403);
  });

  it('DELETE / PATCH / PUT all 403 without origin', async () => {
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const r = await fetch(`http://127.0.0.1:${port}/protected`, {
        method,
        body: method === 'DELETE' ? undefined : '{}',
        headers: { 'content-type': 'application/json' },
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error.startsWith('csrf-failed:')).toBe(true);
    }
  });

  it('CSRF rejection fires http:response-sent observer with 403', async () => {
    const observed: number[] = [];
    harness.bus.subscribe(
      'http:response-sent',
      'csrf-observer',
      async (_ctx, payload) => {
        observed.push((payload as { status: number }).status);
        return undefined;
      },
    );
    await fetch(`http://127.0.0.1:${port}/protected`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(observed).toEqual([403]);
  });
});

describe('csrf — empty allowedOrigins is allowed only with the escape hatch', () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
    else process.env.AX_HTTP_ALLOW_NO_ORIGINS = prevEnv;
  });

  it('warns to stderr when allowedOrigins is empty without the escape hatch', async () => {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: string | Buffer): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    try {
      const plugin = createHttpServerPlugin({
        host: '127.0.0.1',
        port: 0,
        cookieKey: COOKIE_KEY,
        allowedOrigins: [],
      });
      const harness = await createTestHarness({ plugins: [plugin] });
      await harness.close({ onError: () => {} });
    } finally {
      (process.stderr.write as unknown) = origWrite;
    }
    const joined = captured.join('');
    expect(joined).toMatch(/allowedOrigins/);
  });

  it('does NOT warn when AX_HTTP_ALLOW_NO_ORIGINS=1', async () => {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: string | Buffer): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    try {
      const plugin = createHttpServerPlugin({
        host: '127.0.0.1',
        port: 0,
        cookieKey: COOKIE_KEY,
        allowedOrigins: [],
      });
      const harness = await createTestHarness({ plugins: [plugin] });
      await harness.close({ onError: () => {} });
    } finally {
      (process.stderr.write as unknown) = origWrite;
    }
    const joined = captured.join('');
    expect(joined).not.toMatch(/allowedOrigins (is|empty)/);
  });
});
