// ---------------------------------------------------------------------------
// /admin/me + /admin/sign-out — channel-web's `lib/auth.ts` calls these
// directly against @ax/auth-better. Without these routes registered,
// static-files's SPA fallback would return index.html for /admin/me,
// which the SPA can't parse as a session response — every fresh sign-in
// would get bounced to LoginPage.
// ---------------------------------------------------------------------------

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, signInAsAdmin, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin } from '../plugin.js';
import type { AuthBetterDatabase } from '../migrations.js';

const COOKIE_KEY = randomBytes(32);
const ORIGINAL_CREDENTIALS_KEY = process.env.AX_CREDENTIALS_KEY;
const ORIGINAL_ALLOW_NO_ORIGINS = process.env.AX_HTTP_ALLOW_NO_ORIGINS;

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
  process.env.AX_CREDENTIALS_KEY = randomBytes(32).toString('hex');
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
  if (ORIGINAL_CREDENTIALS_KEY === undefined) {
    delete process.env.AX_CREDENTIALS_KEY;
  } else {
    process.env.AX_CREDENTIALS_KEY = ORIGINAL_CREDENTIALS_KEY;
  }
  if (ORIGINAL_ALLOW_NO_ORIGINS === undefined) {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  } else {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = ORIGINAL_ALLOW_NO_ORIGINS;
  }
});

interface BootedStack {
  harness: TestHarness;
  http: HttpServerPlugin;
  baseUrl: string;
  cookieHeader: string;
}

async function dropTables(): Promise<void> {
  const k = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await k.schema.dropTable('auth_providers').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_users').ifExists().execute();
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function bootStack(): Promise<BootedStack> {
  await dropTables();
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const blobs = new Map<string, Uint8Array>();
  const harness = await createTestHarness({
    services: {
      'credentials:store-blob:get': async (_ctx, input) => {
        const ref = (input as { ref: string }).ref;
        const v = blobs.get(ref);
        return v === undefined ? { value: null } : { value: v };
      },
      'credentials:store-blob:put': async (_ctx, input) => {
        const i = input as { ref: string; value: Uint8Array };
        blobs.set(i.ref, i.value);
        return {};
      },
      'credentials:store-blob:list': async () => ({ refs: [...blobs.keys()] }),
      'credentials:store-blob:purge-by-owner': async () => ({ deleted: 0 }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createCredentialsPlugin(),
      http,
      createAuthBetterPlugin(),
    ],
  });
  const baseUrl = `http://127.0.0.1:${http.boundPort()}`;
  const { cookieHeader } = await signInAsAdmin({
    bus: harness.bus,
    cookieKey: COOKIE_KEY,
  });
  return { harness, http, baseUrl, cookieHeader };
}

describe('@ax/auth-better — /admin/me', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
  });

  it('GET /admin/me with a valid session cookie returns { user }', async () => {
    const res = await fetch(`${stack.baseUrl}/admin/me`, {
      headers: { cookie: stack.cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id: string; isAdmin: boolean } };
    expect(body.user).toBeDefined();
    expect(body.user?.isAdmin).toBe(true);
  });

  it('GET /admin/me without a cookie returns 401', async () => {
    const res = await fetch(`${stack.baseUrl}/admin/me`);
    expect(res.status).toBe(401);
  });

  it('GET /admin/me with a forged/unknown signed cookie returns 401', async () => {
    // Passing a random unsigned string in the cookie header — http-server's
    // signedCookie() returns null on a verify miss, so this exercises the
    // same code path as no cookie at all.
    const res = await fetch(`${stack.baseUrl}/admin/me`, {
      headers: { cookie: 'ax_auth_session=not-a-real-signed-cookie' },
    });
    expect(res.status).toBe(401);
  });
});

describe('@ax/auth-better — /admin/sign-out', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
  });

  it('POST /admin/sign-out clears the cookie + invalidates the session', async () => {
    // Sanity: we start signed in.
    const meBefore = await fetch(`${stack.baseUrl}/admin/me`, {
      headers: { cookie: stack.cookieHeader },
    });
    expect(meBefore.status).toBe(200);

    const out = await fetch(`${stack.baseUrl}/admin/sign-out`, {
      method: 'POST',
      headers: {
        cookie: stack.cookieHeader,
        'x-requested-with': 'ax-admin',
      },
    });
    expect(out.status).toBe(200);
    const setCookie = out.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('ax_auth_session=');
    // The clear is signaled by Max-Age=0 (or an Expires in the past) —
    // either is fine; we accept both.
    expect(/(max-age=0|expires=)/i.test(setCookie)).toBe(true);

    // The session row is gone, so even re-presenting the original cookie
    // now returns 401.
    const meAfter = await fetch(`${stack.baseUrl}/admin/me`, {
      headers: { cookie: stack.cookieHeader },
    });
    expect(meAfter.status).toBe(401);
  });

  it('POST /admin/sign-out without a cookie returns 200 (idempotent, no oracle)', async () => {
    const res = await fetch(`${stack.baseUrl}/admin/sign-out`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
    });
    expect(res.status).toBe(200);
  });
});
