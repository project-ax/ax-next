import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin, type HttpServerPlugin } from '../plugin.js';

const COOKIE_KEY = randomBytes(32);
const ALLOWED = ['http://localhost'];

// ---------------------------------------------------------------------------
// HttpRequest.protocol: the scheme http-server decided for this request,
// handed to every route handler. It is the SAME decision that sets cookie
// `Secure`, so a handler building absolute URLs and the cookie it sets can
// never disagree. X-Forwarded-Proto counts only when proxy trust is on
// (AX_TRUST_PROXY=1), and then only a first hop of `https`; anything else —
// untrusted, absent or garbage — is `http`, never an error.
// ---------------------------------------------------------------------------

describe('http-server HttpRequest.protocol', () => {
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
    await harness.bus.call('http:register-route', harness.ctx(), {
      method: 'GET',
      path: '/proto',
      handler: async (req, res) => {
        res.setSignedCookie('probe', 'v');
        res.status(200).json({ protocol: req.protocol });
      },
    });
  });

  afterEach(async () => {
    await harness.close({ onError: () => {} });
    if (prevTrustProxy === undefined) delete process.env.AX_TRUST_PROXY;
    else process.env.AX_TRUST_PROXY = prevTrustProxy;
  });

  it.each([
    { trust: false, xfp: 'https', protocol: 'http' },
    { trust: true, xfp: 'https', protocol: 'https' },
    { trust: true, xfp: 'HTTPS, http', protocol: 'https' },
    { trust: true, xfp: 'a b', protocol: 'http' },
    { trust: true, xfp: undefined, protocol: 'http' },
  ])(
    'trust=$trust, X-Forwarded-Proto=$xfp → $protocol, and cookie Secure agrees',
    async ({ trust, xfp, protocol }) => {
      if (trust) process.env.AX_TRUST_PROXY = '1';
      else delete process.env.AX_TRUST_PROXY;
      const r = await fetch(`http://127.0.0.1:${port}/proto`, {
        headers: xfp === undefined ? {} : { 'x-forwarded-proto': xfp },
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ protocol });
      expect(/; Secure/.test(r.headers.get('set-cookie') ?? '')).toBe(protocol === 'https');
    },
  );
});
