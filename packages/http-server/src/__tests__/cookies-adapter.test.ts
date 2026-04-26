import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin, type HttpServerPlugin } from '../plugin.js';
import { signCookieValue } from '../cookies.js';

const COOKIE_KEY = randomBytes(32);
const ALLOWED = ['http://localhost'];

// ---------------------------------------------------------------------------
// Adapter integration: drives req.signedCookie, res.setSignedCookie,
// res.clearCookie through a real listener so the wire-format details
// (Set-Cookie header semantics, Cookie parsing, X-Forwarded-Proto +
// AX_TRUST_PROXY interaction) are exercised end-to-end.
// ---------------------------------------------------------------------------

describe('http-server signed-cookie adapter', () => {
  let harness: TestHarness;
  let plugin: HttpServerPlugin;
  let port: number;
  let prevTrustProxy: string | undefined;

  beforeEach(async () => {
    prevTrustProxy = process.env.AX_TRUST_PROXY;
    delete process.env.AX_TRUST_PROXY;
    plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: ALLOWED,
    });
    harness = await createTestHarness({ plugins: [plugin] });
    port = plugin.boundPort();
  });

  afterEach(async () => {
    await harness.close({ onError: () => {} });
    if (prevTrustProxy === undefined) delete process.env.AX_TRUST_PROXY;
    else process.env.AX_TRUST_PROXY = prevTrustProxy;
  });

  it('setSignedCookie + req.signedCookie roundtrip via wire', async () => {
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/login',
      handler: async (_req, res) => {
        res.setSignedCookie('ax_sess', 'user-42');
        res.status(200).text('ok');
      },
    });
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/me',
      handler: async (req, res) => {
        const v = req.signedCookie('ax_sess');
        res.status(200).json({ session: v });
      },
    });

    const login = await fetch(`http://127.0.0.1:${port}/login`);
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toMatch(/HttpOnly/);
    expect(setCookie!).toMatch(/SameSite=Lax/);
    expect(setCookie!).toMatch(/Path=\//);
    // Plain HTTP, no proxy trust → no Secure.
    expect(setCookie!).not.toMatch(/Secure/);

    // Extract the cookie name=value (no attrs) and replay.
    const cookieValue = setCookie!.split(';')[0]!.trim();
    const me = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { cookie: cookieValue },
    });
    expect(await me.json()).toEqual({ session: 'user-42' });
  });

  it('req.signedCookie returns null on tampered cookie', async () => {
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/me',
      handler: async (req, res) => {
        const v = req.signedCookie('ax_sess');
        res.status(200).json({ session: v });
      },
    });

    const wire = signCookieValue(COOKIE_KEY, 'orig');
    // Flip one base64url char in the HMAC. We deliberately tamper with the
    // FIRST char of the signature (right after the dot), NOT the last char:
    // a 32-byte HMAC encodes to 43 base64url chars, and the trailing char
    // carries only 4 bits of real data with 2 padding bits at the bottom.
    // Node's lenient base64url decoder ignores those padding bits, so the
    // four chars {A,B,C,D} (and 15 other 4-element groups) decode to
    // identical bytes. Flipping the LAST char between A↔B would slip past
    // verification ~6% of the time depending on the random COOKIE_KEY —
    // the test was previously flaky for exactly this reason. Flipping a
    // non-final char has no such ambiguity.
    const dot = wire.lastIndexOf('.');
    const firstSigChar = wire[dot + 1]!;
    const flipped =
      wire.slice(0, dot + 1) +
      (firstSigChar === 'A' ? 'B' : 'A') +
      wire.slice(dot + 2);

    const r = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { cookie: `ax_sess=${flipped}` },
    });
    expect(await r.json()).toEqual({ session: null });
  });

  it('req.signedCookie returns null when the cookie is absent', async () => {
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/me',
      handler: async (req, res) => {
        res.status(200).json({ session: req.signedCookie('ax_sess') });
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/me`);
    expect(await r.json()).toEqual({ session: null });
  });

  it('Set-Cookie includes Secure when X-Forwarded-Proto: https + AX_TRUST_PROXY=1', async () => {
    process.env.AX_TRUST_PROXY = '1';
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/login',
      handler: async (_req, res) => {
        res.setSignedCookie('ax_sess', 'value');
        res.status(200).text('ok');
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/login`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const setCookie = r.headers.get('set-cookie');
    expect(setCookie).toMatch(/; Secure/);
  });

  it('omits Secure when X-Forwarded-Proto: https BUT proxy trust is off', async () => {
    delete process.env.AX_TRUST_PROXY;
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/login',
      handler: async (_req, res) => {
        res.setSignedCookie('ax_sess', 'value');
        res.status(200).text('ok');
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/login`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const setCookie = r.headers.get('set-cookie');
    expect(setCookie).not.toMatch(/Secure/);
  });

  it('clearCookie emits Max-Age=0 + Expires in the past', async () => {
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'POST',
      path: '/sign-out',
      handler: async (_req, res) => {
        res.clearCookie('ax_sess');
        res.status(200).text('bye');
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/sign-out`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
    });
    const setCookie = r.headers.get('set-cookie');
    expect(setCookie).toMatch(/Max-Age=0/);
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  });

  it('maxAge opt becomes Max-Age=<seconds>', async () => {
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/login',
      handler: async (_req, res) => {
        res.setSignedCookie('ax_sess', 'v', { maxAge: 7200 });
        res.status(200).text('ok');
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/login`);
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=7200/);
  });
});

describe('http-server cookie key — boot', () => {
  let prevEnv: string | undefined;
  let prevAllow: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.AX_HTTP_COOKIE_KEY;
    prevAllow = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
    delete process.env.AX_HTTP_COOKIE_KEY;
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AX_HTTP_COOKIE_KEY;
    else process.env.AX_HTTP_COOKIE_KEY = prevEnv;
    if (prevAllow === undefined) delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
    else process.env.AX_HTTP_ALLOW_NO_ORIGINS = prevAllow;
  });

  it('rejects boot when neither cookieKey opt nor AX_HTTP_COOKIE_KEY env is set', async () => {
    const plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [],
    });
    await expect(
      createTestHarness({ plugins: [plugin] }),
    ).rejects.toMatchObject({ code: 'invalid-cookie-key' });
  });

  it('accepts AX_HTTP_COOKIE_KEY hex env at boot', async () => {
    process.env.AX_HTTP_COOKIE_KEY = 'a'.repeat(64);
    const plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [],
    });
    const harness = await createTestHarness({ plugins: [plugin] });
    await harness.close({ onError: () => {} });
  });

  it('rejects a wrong-length AX_HTTP_COOKIE_KEY env', async () => {
    process.env.AX_HTTP_COOKIE_KEY = 'a'.repeat(32);
    const plugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [],
    });
    await expect(
      createTestHarness({ plugins: [plugin] }),
    ).rejects.toMatchObject({ code: 'invalid-cookie-key' });
  });
});
