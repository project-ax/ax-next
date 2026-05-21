// ---------------------------------------------------------------------------
// Social sign-in (Google OAuth) — headline integration test for Task 3.
//
// Verifies that POST /auth/sign-in/social with provider=google returns a
// Google authorize URL (status 200) rather than a 500 caused by the missing
// `verification` table. The fix is remapping better-auth's model names to
// the existing auth_better_v1_* tables.
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
    await k.schema.dropTable('auth_better_v1_verifications').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_accounts').ifExists().execute();
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

describe('@ax/auth-better — social sign-in (Google)', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
  });

  it('POST /auth/sign-in/social returns a Google authorize url (not 500)', async () => {
    // Configure a google provider at runtime (fires auth:providers-changed →
    // rebuilds the handler with google before the next request returns).
    const create = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: {
        cookie: stack.cookieHeader,
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({ kind: 'google', clientId: 'test-client-id', clientSecret: 'test-secret' }),
    });
    expect(create.status).toBe(201);

    const res = await fetch(`${stack.baseUrl}/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toMatch(/accounts\.google\.com/);
  });

  it('email sign-in bridges better-auth session into a working ax_auth_session cookie', async () => {
    const signUp = await fetch(`${stack.baseUrl}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correcthorsebattery', name: 'Member' }),
    });
    expect([200, 201]).toContain(signUp.status);

    // better-auth auto-signs-in on sign-up, so the sign-up response itself
    // bridges to ax_auth_session (its own session cookie is dropped).
    const signUpCookie = signUp.headers.getSetCookie().join('\n');
    expect(signUpCookie).toContain('ax_auth_session=');
    expect(signUpCookie).not.toContain('ax_better_auth.session_token=');

    const signIn = await fetch(`${stack.baseUrl}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correcthorsebattery' }),
    });
    expect(signIn.status).toBe(200);

    // fetch Response: getSetCookie() returns string[]; join for substring checks.
    const setCookie = signIn.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('ax_auth_session=');
    expect(setCookie).not.toContain('ax_better_auth.session_token=');

    const cookiePair = /ax_auth_session=[^;]+/.exec(setCookie)?.[0] ?? '';
    const me = await fetch(`${stack.baseUrl}/admin/me`, { headers: { cookie: cookiePair } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user?: { email?: string } };
    expect(body.user?.email).toBe('member@example.com');
  });
});
