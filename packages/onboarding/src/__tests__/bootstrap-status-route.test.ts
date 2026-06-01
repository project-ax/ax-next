// ---------------------------------------------------------------------------
// GET /admin/bootstrap-status — read-only status echo for the relocated
// channel-web wizard.
//
// The route is the public surface that lets:
//   - the chat UI on `/` decide whether to redirect to `/setup`
//   - the wizard on `/setup` decide whether to redirect to `/`
// ...without depending on a service-hook RPC. Always 200, never gated.
// ---------------------------------------------------------------------------

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
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createOnboardingPlugin } from '../plugin.js';

const COOKIE_KEY = randomBytes(32);
const TEST_TOKEN = 'ax_bs_bootstrap-status-route-tests';

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
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

async function bootStack(opts?: {
  envOverride?: Record<string, string | undefined>;
}): Promise<BootedStack> {
  await dropTable();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    services: {
      'auth:create-bootstrap-user': async () => ({ user: { id: 'stub', email: null, displayName: null, isAdmin: true }, oneTimeToken: 'stub' }),
      'auth:complete-bootstrap-user': async () => ({ sessionCookie: { name: 'ax_auth_session', value: 'stub', opts: { path: '/', sameSite: 'Lax', maxAge: 60 } } }),
      'auth:require-user': async () => { throw new Error('not expected'); },
      'db:transact': async () => { throw new Error('not expected'); },
      'credentials:set': async () => { throw new Error('not expected'); },
      'agents:create': async () => { throw new Error('not expected'); },
      'storage:set': async () => { throw new Error('not expected'); },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createOnboardingPlugin({
        baseUrl: 'http://127.0.0.1',
        envOverride: opts?.envOverride ?? { AX_BOOTSTRAP_TOKEN: TEST_TOKEN },
      }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

describe('GET /admin/bootstrap-status', () => {
  let stack: BootedStack;

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTable();
  });

  it('returns 200 + status=pending after first boot', async () => {
    stack = await bootStack();
    const res = await fetch(`http://127.0.0.1:${stack.port}/admin/bootstrap-status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; completedAt?: string };
    expect(body.status).toBe('pending');
    expect(body.completedAt).toBeUndefined();
  });

  it('returns 200 + status=completed (with completedAt) after the row is marked done', async () => {
    stack = await bootStack();
    const k = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
    });
    try {
      await sql`UPDATE bootstrap_state SET status='completed', completed_at=NOW() WHERE id=1`.execute(k);
    } finally {
      await k.destroy().catch(() => {});
    }
    const res = await fetch(`http://127.0.0.1:${stack.port}/admin/bootstrap-status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; completedAt?: string };
    expect(body.status).toBe('completed');
    expect(typeof body.completedAt).toBe('string');
  });
});
