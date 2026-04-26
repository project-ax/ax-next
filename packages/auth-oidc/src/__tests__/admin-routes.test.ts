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

// ---------------------------------------------------------------------------
// /admin/me + /admin/sign-out — Task 11.
//
// Both routes are thin /admin/* aliases for surfaces already exercised
// elsewhere; the test file's job is to prove:
//   - /admin/me anon → 401
//   - /admin/me authed → 200 with full User shape
//   - /admin/me with a tampered cookie → 401 (signed-cookie verifier
//     refuses on HMAC mismatch and the route treats that as no cookie)
//   - /admin/sign-out authed → 200 + clears the session cookie
//   - /admin/sign-out anon → 200 (idempotent — no session-existence
//     oracle)
//   - /admin/sign-out shares its handler with /auth/sign-out (smoked
//     by hitting both paths and observing identical responses).
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const TOKEN = 'admin-routes-test-token';

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
 * Drive a real dev-bootstrap to mint a signed session cookie. We extract
 * the wire form (the signed `<payload>.<sig>` blob) so subsequent fetches
 * can present it via a `cookie:` header. Mirrors the cookie path the
 * browser would take.
 */
async function signInAsAdmin(port: number): Promise<{
  cookieHeader: string;
  signedCookieValue: string;
}> {
  const r = await fetch(`http://127.0.0.1:${port}/auth/dev-bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({
      token: TOKEN,
      displayName: 'Admin McAdminface',
      email: 'admin@example.com',
    }),
  });
  if (r.status !== 200) {
    throw new Error(`dev-bootstrap failed: ${r.status} ${await r.text()}`);
  }
  const setCookies =
    r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  const sessionCookie = setCookies.find((c) =>
    c.startsWith('ax_auth_session='),
  );
  if (sessionCookie === undefined) {
    throw new Error('expected ax_auth_session in Set-Cookie');
  }
  // Strip attributes (Path=/, HttpOnly, etc.) — keep just `name=value`.
  const cookieHeader = sessionCookie.split(';')[0]!;
  const signedCookieValue = cookieHeader.slice('ax_auth_session='.length);
  return { cookieHeader, signedCookieValue };
}

describe('@ax/auth-oidc /admin/me + /admin/sign-out', () => {
  let stack: BootedStack;

  afterEach(async () => {
    if (stack !== undefined) {
      await stack.harness.close({ onError: () => {} });
    }
    await dropTables();
  });

  it('GET /admin/me without a session cookie → 401', async () => {
    stack = await bootStack();
    const r = await fetch(`http://127.0.0.1:${stack.port}/admin/me`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('GET /admin/me with a valid signed cookie → 200 with full User shape', async () => {
    stack = await bootStack();
    const { cookieHeader } = await signInAsAdmin(stack.port);
    const r = await fetch(`http://127.0.0.1:${stack.port}/admin/me`, {
      headers: { cookie: cookieHeader },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      user: {
        id: string;
        email: string | null;
        displayName: string | null;
        isAdmin: boolean;
      };
    };
    // Shape — every field on User must be present (Task 11 self-review).
    expect(typeof body.user.id).toBe('string');
    expect(body.user.id.length).toBeGreaterThan(0);
    expect(body.user.email).toBe('admin@example.com');
    expect(body.user.displayName).toBe('Admin McAdminface');
    expect(body.user.isAdmin).toBe(true);
    // Probe for unexpected leaks (sessionId / oneTimeToken / provider) —
    // I9: tokens never leak through hook return values, and the wire
    // surface must not echo them either.
    expect(body.user).not.toHaveProperty('sessionId');
    expect(body.user).not.toHaveProperty('oneTimeToken');
  });

  it('GET /admin/me with a tampered cookie → 401', async () => {
    stack = await bootStack();
    const { signedCookieValue } = await signInAsAdmin(stack.port);
    // Flip the last char of the signature. base64url alphabet has plenty
    // of options; we pick 'A' or 'B' to be safe regardless of original.
    const last = signedCookieValue.slice(-1);
    const swapped = last === 'A' ? 'B' : 'A';
    const tampered = signedCookieValue.slice(0, -1) + swapped;
    const r = await fetch(`http://127.0.0.1:${stack.port}/admin/me`, {
      headers: { cookie: `ax_auth_session=${tampered}` },
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('POST /admin/sign-out with valid cookie → 200 and clears the session cookie', async () => {
    stack = await bootStack();
    const { cookieHeader } = await signInAsAdmin(stack.port);
    const r = await fetch(`http://127.0.0.1:${stack.port}/admin/sign-out`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        // CSRF bypass header — same posture as @ax/auth's existing
        // /auth/dev-bootstrap fetches in the dev-bootstrap suite.
        'x-requested-with': 'ax-admin',
      },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    // Set-Cookie should clear the session (Max-Age=0 or Expires in the
    // past — http-server's clearCookie writes an immediately-expired
    // cookie for the same name).
    const setCookies =
      r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
    const cleared = setCookies.find((c) =>
      c.startsWith('ax_auth_session='),
    );
    expect(cleared).toBeDefined();
    // Either Max-Age=0 or an Expires in the past indicates clearing.
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    // The session row is gone — a follow-up /admin/me with the SAME
    // signed cookie value comes back 401 (signature still verifies, but
    // the session_id no longer resolves to a user).
    const probe = await fetch(`http://127.0.0.1:${stack.port}/admin/me`, {
      headers: { cookie: cookieHeader },
    });
    expect(probe.status).toBe(401);
  });

  it('POST /admin/sign-out without a cookie → 200 (idempotent)', async () => {
    stack = await bootStack();
    const r = await fetch(`http://127.0.0.1:${stack.port}/admin/sign-out`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('POST /auth/sign-out and POST /admin/sign-out share the same handler', async () => {
    // Both paths register the same factory-returned handler closure in
    // plugin.ts. We probe both with no cookie and assert identical
    // wire shape — proves no behavioral drift between the two registrations.
    stack = await bootStack();
    const a = await fetch(`http://127.0.0.1:${stack.port}/auth/sign-out`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
    });
    const b = await fetch(`http://127.0.0.1:${stack.port}/admin/sign-out`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
    });
    expect(a.status).toBe(b.status);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });
});
