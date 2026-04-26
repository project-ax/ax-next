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
import type { AuthDatabase } from '../migrations.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// /auth/dev-bootstrap + auth:create-bootstrap-user.
//
// Covers:
//   - Happy path: POST with valid token → 200, cookie set, user row in DB
//   - Wrong token → 401, no row created
//   - NODE_ENV=production → 404 (existence not leaked)
//   - Idempotent: second POST reuses the existing user row
//   - auth:create-bootstrap-user hook returns {user, oneTimeToken} that
//     points at a real session row (the cookie value).
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const TOKEN = 'super-secret-bootstrap-token-do-not-share';

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
});

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

interface BootedStack {
  harness: TestHarness;
  http: HttpServerPlugin;
  port: number;
}

async function bootStack(devToken?: string | null): Promise<BootedStack> {
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
        devBootstrap:
          devToken === null || devToken === undefined
            ? undefined
            : { token: devToken },
      }),
    ],
  });
  return { harness, http, port: http.boundPort() };
}

function setProduction(on: boolean): void {
  if (on) process.env.NODE_ENV = 'production';
  else delete process.env.NODE_ENV;
}

describe('/auth/dev-bootstrap', () => {
  let stack: BootedStack;

  afterEach(async () => {
    setProduction(false);
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTables();
  });

  it('happy path: valid token → 200, cookie set, user row + admin flag', async () => {
    stack = await bootStack(TOKEN);
    const r = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({
        token: TOKEN,
        displayName: 'First Admin',
        email: 'admin@example.com',
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      user: { id: string; isAdmin: boolean; email: string | null };
      isNew: boolean;
    };
    expect(body.user.isAdmin).toBe(true);
    expect(body.user.email).toBe('admin@example.com');
    // First call: bootstrap created a fresh user.
    expect(body.isNew).toBe(true);
    // Cookie set.
    const setCookie =
      r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
    expect(setCookie.some((c) => c.startsWith('ax_auth_session='))).toBe(true);

    // DB has exactly one user row, marked admin.
    const k = new Kysely<AuthDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const users = await k
        .selectFrom('auth_v1_users')
        .select(['user_id', 'auth_provider', 'auth_subject_id', 'is_admin'])
        .execute();
      expect(users).toHaveLength(1);
      expect(users[0]!.auth_provider).toBe('dev-bootstrap');
      expect(users[0]!.auth_subject_id).toBe('admin');
      expect(users[0]!.is_admin).toBe(true);
    } finally {
      await k.destroy().catch(() => {});
    }
  });

  it('wrong token → 401', async () => {
    stack = await bootStack(TOKEN);
    const r = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    expect(r.status).toBe(401);
    // No cookie set.
    const setCookie =
      r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
    expect(setCookie.some((c) => c.startsWith('ax_auth_session='))).toBe(false);
  });

  it('without devBootstrap config: init throws no-auth-providers when nothing else is configured', async () => {
    // No devBootstrap, no providers, NODE_ENV not production.
    let caught: unknown;
    try {
      await bootStack(null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('no-auth-providers');
  });

  it('NODE_ENV=production → init throws (path is refused entirely)', async () => {
    setProduction(true);
    let caught: unknown;
    try {
      await bootStack(TOKEN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // PluginError is passed through the bootstrap chain unwrapped (see
    // bootstrap.ts: `if (err instanceof PluginError) throw err`). The
    // plugin's own code wins so callers can distinguish the failure mode.
    expect((caught as { code?: string }).code).toBe(
      'dev-bootstrap-in-production',
    );
  });

  it('idempotent: second POST with same token reuses existing user', async () => {
    stack = await bootStack(TOKEN);
    const a = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ token: TOKEN, displayName: 'Admin1' }),
    });
    expect(a.status).toBe(200);
    const ja = (await a.json()) as { user: { id: string }; isNew: boolean };
    expect(ja.isNew).toBe(true);
    const b = await fetch(`http://127.0.0.1:${stack.port}/auth/dev-bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ token: TOKEN, displayName: 'IgnoredOnSecondCall' }),
    });
    expect(b.status).toBe(200);
    const jb = (await b.json()) as { user: { id: string }; isNew: boolean };
    expect(jb.user.id).toBe(ja.user.id);
    // Second call: existing user reused — CLI uses this to print
    // bootstrap_already_done.
    expect(jb.isNew).toBe(false);

    // DB still has exactly one user; two sessions.
    const k = new Kysely<AuthDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const users = await k.selectFrom('auth_v1_users').selectAll().execute();
      expect(users).toHaveLength(1);
      const sessions = await k
        .selectFrom('auth_v1_sessions')
        .selectAll()
        .execute();
      expect(sessions).toHaveLength(2);
    } finally {
      await k.destroy().catch(() => {});
    }
  });

  it('auth:create-bootstrap-user service hook mints a user + token', async () => {
    stack = await bootStack(TOKEN);
    const out = await stack.harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', stack.harness.ctx(), {
      displayName: 'Hook Admin',
    });
    expect(out.user.isAdmin).toBe(true);
    expect(out.oneTimeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The token IS a real session_id — points at the user's row.
    const k = new Kysely<AuthDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const row = await k
        .selectFrom('auth_v1_sessions')
        .select(['session_id', 'user_id'])
        .where('session_id', '=', out.oneTimeToken)
        .executeTakeFirst();
      expect(row).toBeDefined();
      expect(row!.user_id).toBe(out.user.id);
    } finally {
      await k.destroy().catch(() => {});
    }
  });
});
