import { randomBytes } from 'node:crypto';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin } from '@ax/auth-oidc';
import { createOnboardingPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// POST /setup/admin — Task 2.6 integration tests.
//
// Boots: database-postgres + http-server + auth-oidc + onboarding.
// Exercises:
//   - happy path: claim → admin → cookie swap (bootstrap-session cleared,
//     auth-session issued), next = '/setup/model'
//   - missing bootstrap-session cookie → 401
//   - invalid email → 400
//   - missing name → 400
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const TEST_TOKEN = 'ax_bs_test-token-for-admin-tests';
const BOOTSTRAP_SESSION_COOKIE = 'ax_bootstrap_session';

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
});

interface BootedStack {
  harness: TestHarness;
  http: HttpServerPlugin;
  port: number;
}

async function dropTables(): Promise<void> {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  try {
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_v1_sessions`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_v1_users`.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function bootStack(): Promise<BootedStack> {
  await dropTables();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createAuthPlugin({
        providers: {},
        devBootstrap: { token: 'auth-oidc-dev-bootstrap-token' },
      }),
      createOnboardingPlugin({
        baseUrl: `http://127.0.0.1`,
        envOverride: { AX_BOOTSTRAP_TOKEN: TEST_TOKEN },
      }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

/**
 * POST /setup/claim with the test token and return the bootstrap-session
 * cookie header value ready to be used as a `cookie:` header.
 */
async function claimAndExtract(
  port: number,
): Promise<{ bootstrapCookie: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({ token: TEST_TOKEN }),
  });
  if (res.status !== 200) {
    throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  }
  const setCookies =
    res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const bootstrapSetCookie = setCookies.find((c) =>
    c.startsWith(`${BOOTSTRAP_SESSION_COOKIE}=`),
  );
  if (bootstrapSetCookie === undefined) {
    throw new Error(`expected ${BOOTSTRAP_SESSION_COOKIE} in Set-Cookie`);
  }
  // Strip attributes — keep just `name=value`.
  const bootstrapCookie = bootstrapSetCookie.split(';')[0]!;
  return { bootstrapCookie };
}

describe('@ax/onboarding POST /setup/admin', () => {
  let stack: BootedStack;

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTables();
  });

  it('happy path: creates admin, swaps bootstrap-session for auth session', async () => {
    stack = await bootStack();
    const { port } = stack;

    const { bootstrapCookie } = await claimAndExtract(port);

    const res = await fetch(`http://127.0.0.1:${port}/setup/admin`, {
      method: 'POST',
      headers: {
        cookie: bootstrapCookie,
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ name: 'Vinay', email: 'v@example.com' }),
    });

    expect(res.status).toBe(200);
    expect((await res.json() as { next: string }).next).toBe('/setup/model');

    const setCookies =
      res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];

    // Bootstrap session cookie cleared (Max-Age=0).
    const clearedBootstrap = setCookies.find(
      (c) =>
        c.startsWith(`${BOOTSTRAP_SESSION_COOKIE}=`) && /Max-Age=0/.test(c),
    );
    expect(clearedBootstrap).toBeDefined();

    // Auth session cookie issued.
    const authCookie = setCookies.find((c) => c.startsWith('ax_auth_session='));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/Path=\//);
    expect(authCookie).toMatch(/SameSite=Lax/);
    expect(authCookie).toMatch(/HttpOnly/);
  });

  it('without bootstrap cookie → 401', async () => {
    stack = await bootStack();
    const { port } = stack;

    const res = await fetch(`http://127.0.0.1:${port}/setup/admin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ name: 'Vinay', email: 'v@example.com' }),
    });

    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('no-bootstrap-session');
  });

  it('invalid email → 400', async () => {
    stack = await bootStack();
    const { port } = stack;

    const { bootstrapCookie } = await claimAndExtract(port);

    const res = await fetch(`http://127.0.0.1:${port}/setup/admin`, {
      method: 'POST',
      headers: {
        cookie: bootstrapCookie,
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ name: 'Vinay', email: 'not-an-email' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid-email');
  });

  it('missing name → 400', async () => {
    stack = await bootStack();
    const { port } = stack;

    const { bootstrapCookie } = await claimAndExtract(port);

    const res = await fetch(`http://127.0.0.1:${port}/setup/admin`, {
      method: 'POST',
      headers: {
        cookie: bootstrapCookie,
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ name: '', email: 'v@example.com' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('missing-name');
  });
});
