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
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin } from '../plugin.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
} from '../types.js';
import type { AuthDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// auth:complete-bootstrap-user integration tests — Task 2.6.
//
// Verifies that the hook correctly packages a pre-minted sessionId (the
// oneTimeToken from auth:create-bootstrap-user) into a cookie payload
// consumable by @ax/onboarding's /setup/admin route.
// ---------------------------------------------------------------------------

const TOKEN = 'bootstrap-user-test-token';

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
  const k = new Kysely<AuthDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await k.schema.dropTable('auth_v1_sessions').ifExists().execute();
    await k.schema.dropTable('auth_v1_users').ifExists().execute();
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
    cookieKey: randomBytes(32),
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createAuthPlugin({ providers: {}, devBootstrap: { token: TOKEN } }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

describe('@ax/auth-oidc auth:complete-bootstrap-user', () => {
  let stack: BootedStack;

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTables();
  });

  it('maps oneTimeToken to a cookie payload', async () => {
    stack = await bootStack();

    const { oneTimeToken } = await stack.harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', stack.harness.ctx(), {
      displayName: 'Bootstrap Admin',
      email: 'admin@example.com',
    });

    const { sessionCookie } = await stack.harness.bus.call<
      CompleteBootstrapUserInput,
      CompleteBootstrapUserOutput
    >('auth:complete-bootstrap-user', stack.harness.ctx(), { oneTimeToken });

    expect(sessionCookie.name).toBe('ax_auth_session');
    expect(sessionCookie.value).toBe(oneTimeToken);
    expect(sessionCookie.opts.path).toBe('/');
    expect(sessionCookie.opts.sameSite).toBe('Lax');
    expect(sessionCookie.opts.maxAge).toBeGreaterThan(0);
  });

  it('ignores password (Phase 2 — auth-oidc has no local password)', async () => {
    stack = await bootStack();

    const { oneTimeToken } = await stack.harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', stack.harness.ctx(), {
      displayName: 'Bootstrap Admin 2',
    });

    const result = await stack.harness.bus.call<
      CompleteBootstrapUserInput,
      CompleteBootstrapUserOutput
    >('auth:complete-bootstrap-user', stack.harness.ctx(), {
      oneTimeToken,
      password: 'phase-1-forward-compat',
    });

    expect(result.sessionCookie.value).toBe(oneTimeToken);
  });
});
