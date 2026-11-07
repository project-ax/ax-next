import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { requestWithHost } from './support/request-with-host.js';

// ---------------------------------------------------------------------------
// TASK-1052: the scheme and host Better Auth sees. With no pinned `baseURL`
// (AX_PUBLIC_BASE_URL unset: kind, local, tests), Better Auth takes its base
// URL, its trusted origin and the OAuth `redirect_uri` from the request URL
// we hand it. So the scheme must be http-server's own decision
// (`X-Forwarded-Proto` counts only under AX_TRUST_PROXY=1), and a Host may
// not move the path Better Auth routes on.
//
// No Docker. Better Auth is mocked to record the URL of every Request it is
// handed (and the config it was built with) and to answer 200. Init only needs
// the migration and the provider load, which kysely's DummyDriver satisfies
// with no rows. The real @ax/http-server and real sockets complete the stack.
// Its own file because the `better-auth` module mock would break the files
// that use the real one.
// ---------------------------------------------------------------------------

const { seen, configs } = vi.hoisted(() => ({
  seen: [] as string[],
  configs: [] as Array<{ advanced?: { trustedProxyHeaders?: unknown } }>,
}));

vi.mock('better-auth', () => ({
  betterAuth: (cfg: { advanced?: { trustedProxyHeaders?: unknown } }) => {
    configs.push(cfg);
    return {
      handler: async (r: Request) => {
        seen.push(r.url);
        return Response.json({ ok: true });
      },
      $context: Promise.resolve({}),
    };
  },
}));

// Import the plugin AFTER vi.mock so its handler is built by the mock.
const { createAuthBetterPlugin } = await import('../plugin.js');

const ORIGINAL_ALLOW_NO_ORIGINS = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
const ORIGINAL_TRUST_PROXY = process.env.AX_TRUST_PROXY;
let harness: TestHarness | undefined;
let port: number;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const inertDb = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: randomBytes(32),
    allowedOrigins: [],
  });
  harness = await createTestHarness({
    services: {
      'database:get-instance': async () => ({ db: inertDb }),
      // The plugin declares both in `calls`. The inert database has no
      // provider rows, so neither is ever reached.
      'credentials:envelope-encrypt': async (_ctx, input) => ({
        ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
      }),
      'credentials:envelope-decrypt': async (_ctx, input) => ({
        plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
      }),
    },
    plugins: [http, createAuthBetterPlugin()],
  });
  port = http.boundPort();
});

beforeEach(() => {
  delete process.env.AX_TRUST_PROXY;
  // One request per test, one recorded URL per request.
  seen.length = 0;
});

afterAll(async () => {
  await harness?.close({ onError: () => {} });
  restoreEnv('AX_HTTP_ALLOW_NO_ORIGINS', ORIGINAL_ALLOW_NO_ORIGINS);
  restoreEnv('AX_TRUST_PROXY', ORIGINAL_TRUST_PROXY);
});

function getSession(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/auth/get-session`, { headers });
}

describe('@ax/auth-better: the URL Better Auth sees (TASK-1052)', () => {
  it('trust off: x-forwarded-proto https on a plain connection — Better Auth sees http', async () => {
    const r = await getSession({ 'x-forwarded-proto': 'https' });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).protocol).toBe('http:');
  });

  it('trust on: x-forwarded-proto https — Better Auth sees https', async () => {
    process.env.AX_TRUST_PROXY = '1';
    const r = await getSession({ 'x-forwarded-proto': 'https' });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).protocol).toBe('https:');
  });

  it.each([false, true])(
    'trust=%s: a malformed x-forwarded-proto (a b) — Better Auth sees http and answers',
    async (trust) => {
      if (trust) process.env.AX_TRUST_PROXY = '1';
      const r = await getSession({ 'x-forwarded-proto': 'a b' });
      expect(r.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!).protocol).toBe('http:');
    },
  );

  it('an empty Host keeps the path Better Auth routes on', async () => {
    const r = await requestWithHost(port, { method: 'GET', path: '/auth/get-session', host: '' });
    expect(r.status).toBe(200);
    expect(seen).toEqual(['http://localhost/auth/get-session']);
  });

  // Better Auth is mocked here, so it answers even a refused Host: the status
  // is the mock's 200. The real refusal is malformed-host-rate-limit.test.ts.
  it.each(['evil.example/x', 'evil.example?x', 'evil.example#x'])(
    'a Host that smuggles %j never moves the path',
    async (host) => {
      const r = await requestWithHost(port, { method: 'GET', path: '/auth/get-session', host });
      expect(r.status).toBe(200);
      expect(seen).toHaveLength(1);
      const url = new URL(seen[0]!);
      expect(url.host).toBe('localhost');
      expect(url.pathname).toBe('/auth/get-session');
    },
  );

  it('Better Auth is not told to read proxy headers itself', () => {
    // With it on, Better Auth would read a client's X-Forwarded-Proto again
    // (`getBaseURL`), around http-server's proxy-trust decision.
    expect(configs.length).toBeGreaterThan(0);
    expect(configs.at(-1)?.advanced?.trustedProxyHeaders).not.toBe(true);
  });
});
