import { randomBytes } from 'node:crypto';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin } from '../plugin.js';
import type { AuthDatabase } from '../migrations.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  HttpRequestLike,
  RequireUserInput,
  RequireUserOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// auth:require-user — the gate every admin endpoint will sit behind.
//
// Covers:
//   - No cookie → throws PluginError code 'unauthenticated'
//   - Tampered (HMAC mismatch) cookie surfaces as no-cookie via signedCookie
//   - Expired session row → throws unauthenticated
//   - Valid session → returns { user }
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const TOKEN = 'cookie-session-test-token';

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
    cookieKey: COOKIE_KEY,
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

/**
 * Build a fake HttpRequestLike whose `signedCookie` returns the supplied
 * value verbatim. Lets us call auth:require-user directly without booting
 * a full HTTP request (we trust @ax/http-server's signed-cookie path is
 * tested in its own suite).
 */
function fakeReq(sessionPlaintext: string | null): HttpRequestLike {
  return {
    headers: {},
    signedCookie(name: string): string | null {
      if (name === 'ax_auth_session') return sessionPlaintext;
      return null;
    },
  };
}

describe('auth:require-user', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    await stack.harness.close({ onError: () => {} });
    await dropTables();
  });

  it('rejects with unauthenticated when there is no session cookie', async () => {
    let caught: unknown;
    try {
      await stack.harness.bus.call<RequireUserInput, RequireUserOutput>(
        'auth:require-user',
        stack.harness.ctx(),
        { req: fakeReq(null) },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unauthenticated');
  });

  it('rejects with unauthenticated when the session id is unknown', async () => {
    let caught: unknown;
    try {
      await stack.harness.bus.call<RequireUserInput, RequireUserOutput>(
        'auth:require-user',
        stack.harness.ctx(),
        // 43-char base64url shape — passes signedCookie's structural check
        // (its signature is checked by http-server, not us; here we model
        // a random plaintext that survived signing but has no DB row).
        { req: fakeReq(randomBytes(32).toString('base64url')) },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unauthenticated');
  });

  it('rejects with unauthenticated when the session row is expired', async () => {
    // Mint a session via the bootstrap hook, then backdate expires_at.
    const out = await stack.harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', stack.harness.ctx(), {
      displayName: 'Expirable Admin',
    });

    const k = new Kysely<AuthDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      await k
        .updateTable('auth_v1_sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('session_id', '=', out.oneTimeToken)
        .execute();
    } finally {
      await k.destroy().catch(() => {});
    }

    let caught: unknown;
    try {
      await stack.harness.bus.call<RequireUserInput, RequireUserOutput>(
        'auth:require-user',
        stack.harness.ctx(),
        { req: fakeReq(out.oneTimeToken) },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unauthenticated');
  });

  it('returns { user } when the cookie points at a live session', async () => {
    const out = await stack.harness.bus.call<
      CreateBootstrapUserInput,
      CreateBootstrapUserOutput
    >('auth:create-bootstrap-user', stack.harness.ctx(), {
      displayName: 'Live Admin',
    });
    const result = await stack.harness.bus.call<RequireUserInput, RequireUserOutput>(
      'auth:require-user',
      stack.harness.ctx(),
      { req: fakeReq(out.oneTimeToken) },
    );
    expect(result.user.id).toBe(out.user.id);
    expect(result.user.isAdmin).toBe(true);
  });
});
