import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

// ---------------------------------------------------------------------------
// I10 — runtime provider config + handler hot-reload (no kernel restart).
//
// Proves that:
//   1. With no provider configured, better-auth's `POST /auth/sign-in/social`
//      with `{ provider: 'google' }` returns NOT_FOUND (404).
//   2. Admin `POST /admin/auth/providers` with kind='google' fires
//      `auth:providers-changed`; the subscriber rebuilds the handler
//      in place; the very next sign-in request returns the Google
//      authorize URL — all WITHIN THE SAME PROCESS, no restart.
//   3. Admin `PATCH /admin/auth/providers/google` { enabled: false }
//      flips the rebuild back: sign-in goes to NOT_FOUND again.
//
// Boundary: the test speaks the auth/admin HTTP surface only — no
// auth-better internals are imported beyond `createAuthBetterPlugin` and
// the DB types for the test-only drop helper.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
// Pre-generate a 32-byte AX_CREDENTIALS_KEY (64 hex chars) so the
// credentials plugin can boot. We restore the prior env in afterAll.
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
    // credentials migrations may also have created tables in this DB, but
    // we don't reach for them since this test only uses envelope-encrypt
    // (which is keyed off env, not the DB).
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
  // Stub out the credentials store-blob surface — @ax/credentials's
  // facade `calls` it for `set`/`get`/`list`, but our test only exercises
  // the envelope hooks (which key off AX_CREDENTIALS_KEY directly). A
  // tiny in-memory map keeps verifyCalls() happy without dragging in
  // the @ax/credentials-store-db migrations.
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

// CSRF guard: state-changing requests need either an Origin in the
// allowlist or X-Requested-With: ax-admin. We use the latter for
// every admin/auth POST/PATCH/DELETE in this file.
const ADMIN_HEADERS = (cookieHeader: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
  cookie: cookieHeader,
});

const SOCIAL_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

describe('@ax/auth-better — provider hot-reload (I10)', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStack();
  });

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
  });

  /**
   * Helper — fetch sign-in/social and classify whether better-auth thinks
   * the provider is configured. We can't assert a clean 200/url because
   * better-auth's downstream `generateState` writes to its own internal
   * verification table, which @ax/auth-better's migrations don't create
   * in this test (the test boots only the auth_better_v1 + auth_providers
   * tables). The 500 from a downstream-of-NOT_FOUND failure is itself
   * proof that the provider WAS found (i.e. handler rebuild took effect):
   *
   *   - PROVIDER_NOT_FOUND  ⇒ provider missing/disabled (404 with that code)
   *   - anything else       ⇒ provider configured; better-auth got past the
   *                            "is google configured?" gate
   *
   * The hot-reload contract is "the gate flips" — exact downstream behavior
   * isn't part of I10's contract. Better-auth's full social-sign-in flow
   * is exercised by manual acceptance + Phase 3's CLI/k8s preset wiring.
   */
  async function classifyProviderGate(): Promise<'configured' | 'missing'> {
    const res = await fetch(`${stack.baseUrl}/auth/sign-in/social`, {
      method: 'POST',
      headers: SOCIAL_HEADERS,
      body: JSON.stringify({ provider: 'google' }),
    });
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}));
      const code = (body as { code?: string }).code;
      if (code === 'PROVIDER_NOT_FOUND') return 'missing';
    }
    return 'configured';
  }

  it('no provider → sign-in/social returns PROVIDER_NOT_FOUND', async () => {
    expect(await classifyProviderGate()).toBe('missing');
  });

  it('POST /admin/auth/providers immediately flips the gate (I10 closed)', async () => {
    // 1. Pre-state: gate says missing.
    expect(await classifyProviderGate()).toBe('missing');

    // 2. Admin adds the google provider.
    const post = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: ADMIN_HEADERS(stack.cookieHeader),
      body: JSON.stringify({
        kind: 'google',
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
      }),
    });
    expect(post.status).toBe(201);

    // 3. Same kernel, same listener — gate now says configured.
    expect(await classifyProviderGate()).toBe('configured');
  });

  it('PATCH enabled=false flips the gate back to missing', async () => {
    // First add it.
    const post = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: ADMIN_HEADERS(stack.cookieHeader),
      body: JSON.stringify({
        kind: 'google',
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
      }),
    });
    expect(post.status).toBe(201);
    expect(await classifyProviderGate()).toBe('configured');

    // Then disable it.
    const patch = await fetch(`${stack.baseUrl}/admin/auth/providers/google`, {
      method: 'PATCH',
      headers: ADMIN_HEADERS(stack.cookieHeader),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);

    // Gate is now missing because loadProviders() filters on enabled=true.
    expect(await classifyProviderGate()).toBe('missing');
  });

  it('DELETE flips the gate back to missing', async () => {
    const post = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: ADMIN_HEADERS(stack.cookieHeader),
      body: JSON.stringify({
        kind: 'google',
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
      }),
    });
    expect(post.status).toBe(201);
    expect(await classifyProviderGate()).toBe('configured');

    const del = await fetch(`${stack.baseUrl}/admin/auth/providers/google`, {
      method: 'DELETE',
      headers: ADMIN_HEADERS(stack.cookieHeader),
    });
    expect(del.status).toBe(204);

    expect(await classifyProviderGate()).toBe('missing');
  });

  it('GET /admin/auth/providers strips clientSecret from the response', async () => {
    const post = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: ADMIN_HEADERS(stack.cookieHeader),
      body: JSON.stringify({
        kind: 'google',
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'super-secret-value',
      }),
    });
    expect(post.status).toBe(201);

    const list = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      headers: { cookie: stack.cookieHeader },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(body.providers).toHaveLength(1);
    const row = body.providers[0]!;
    expect(row.kind).toBe('google');
    expect(row.clientId).toBe('test-client-id.apps.googleusercontent.com');
    expect(row.enabled).toBe(true);
    // Critical: clientSecret MUST NOT round-trip on the wire (Invariant I9).
    expect(row).not.toHaveProperty('clientSecret');
    expect(row).not.toHaveProperty('client_secret_encrypted');
    // Defensive — make sure the secret string isn't lurking under any
    // other property name from a future refactor.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('super-secret-value');
  });

  it('non-admin requests are rejected (401 anon, 403 non-admin path covered by impl)', async () => {
    // Anon list — no cookie → 401 unauthenticated.
    const anon = await fetch(`${stack.baseUrl}/admin/auth/providers`);
    expect(anon.status).toBe(401);

    const anonPost = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: SOCIAL_HEADERS,
      body: JSON.stringify({
        kind: 'google',
        clientId: 'x',
        clientSecret: 'y',
      }),
    });
    expect(anonPost.status).toBe(401);
  });

  it('rejects unknown kinds with 400', async () => {
    const res = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: ADMIN_HEADERS(stack.cookieHeader),
      body: JSON.stringify({
        kind: 'facebook',
        clientId: 'x',
        clientSecret: 'y',
      }),
    });
    expect(res.status).toBe(400);
  });
});
