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
import { createOnboardingPlugin } from '../plugin.js';

const COOKIE_KEY = randomBytes(32);
const TEST_TOKEN = 'ax_bs_test-token-for-claim-tests';

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

async function dropTable(): Promise<void> {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  try {
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function bootStack(): Promise<BootedStack> {
  await dropTable();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    // Stub the auth/tx/credential/agent hooks that onboarding declares in its
    // `calls`. claim-route.test.ts doesn't load auth-oidc, storage-postgres,
    // credentials, or agents; those routes are not exercised here, so stubs
    // satisfy verifyCalls without weakening any assertion.
    services: {
      'auth:create-bootstrap-user': async () => ({ user: { id: 'stub', email: null, displayName: null, isAdmin: true }, oneTimeToken: 'stub-token' }),
      'auth:complete-bootstrap-user': async () => ({ sessionCookie: { name: 'ax_auth_session', value: 'stub', opts: { path: '/', sameSite: 'Lax', maxAge: 60 } } }),
      'auth:require-user': async () => { throw new Error('auth:require-user not expected in claim-route tests'); },
      'db:transact': async () => { throw new Error('db:transact not expected in claim-route tests'); },
      'credentials:set': async () => { throw new Error('credentials:set not expected in claim-route tests'); },
      'agents:create': async () => { throw new Error('agents:create not expected in claim-route tests'); },
      'storage:set': async () => { throw new Error('storage:set not expected in claim-route tests'); },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createOnboardingPlugin({
        baseUrl: `http://127.0.0.1`,
        envOverride: { AX_BOOTSTRAP_TOKEN: TEST_TOKEN },
      }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

describe('@ax/onboarding POST /setup/claim', () => {
  let stack: BootedStack;

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTable();
  });

  it('happy path: 200 + cookie scoped to /setup/*', async () => {
    stack = await bootStack();
    const { port } = stack;

    const res = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { next: string }).next).toBe('/setup/admin');

    const cookieHeader = res.headers.get('set-cookie')!;
    expect(cookieHeader).not.toBeNull();
    expect(cookieHeader).toMatch(/^ax_bootstrap_session=/);
    expect(cookieHeader).toMatch(/Path=\/setup/);
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Strict/);
  });

  it('replay: second claim with same token → 410', async () => {
    stack = await bootStack();
    const { port } = stack;
    const body = JSON.stringify({ token: TEST_TOKEN });
    const headers = {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    };

    const first = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
      method: 'POST',
      headers,
      body,
    });
    expect(first.status).toBe(200);

    const second = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
      method: 'POST',
      headers,
      body,
    });
    expect(second.status).toBe(410);
  });

  it('wrong token → 401', async () => {
    stack = await bootStack();
    const { port } = stack;

    const res = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ token: 'ax_bs_wrong-test-token-here' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rate limit: 6th wrong attempt from same IP → 429', async () => {
    stack = await bootStack();
    const { port } = stack;
    const headers = {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    };
    const body = JSON.stringify({ token: 'ax_bs_wrong-token' });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
        method: 'POST',
        headers,
        body,
      });
      statuses.push(r.status);
    }

    // First 5 wrong → 401, 6th → 429.
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it('post-completion: returns 410', async () => {
    stack = await bootStack();
    const { port } = stack;

    // Manually complete the row to simulate wizard already finished.
    const k = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
    });
    try {
      await sql`UPDATE bootstrap_state SET status='completed', completed_at=NOW() WHERE id=1`.execute(k);
    } finally {
      await k.destroy().catch(() => {});
    }

    const res = await fetch(`http://127.0.0.1:${port}/setup/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    expect(res.status).toBe(410);
    expect((await res.json() as { error: string }).error).toBe('wizard-complete');
  });
});
