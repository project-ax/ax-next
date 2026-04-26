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
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin } from '../plugin.js';
import type { AuthDatabase } from '../migrations.js';
import { OIDC_STATE_COOKIE } from '../oidc.js';
import { startFakeIdp, type StartedFakeIdp } from './fake-idp.js';

// ---------------------------------------------------------------------------
// End-to-end OIDC handshake against an in-process fake IdP.
//
// What we exercise:
//   - GET /auth/sign-in/google → 302 to IdP, with state cookie set
//   - Browser flow: follow redirect → fake IdP → 302 back with code+state
//   - GET /auth/callback/google?code=...&state=... → tokens exchanged,
//     user row + session row created, ax_auth_session cookie set,
//     302 to '/'
//   - Subsequent /auth/sign-in/google for SAME sub does NOT duplicate the
//     user row (UNIQUE on auth_provider, auth_subject_id catches; we
//     look up first)
//   - Tampered state cookie → 400 callback-failed
//   - Mismatched state in query → 400 callback-failed
//   - Missing state cookie (cleared before callback) → 400
//
// We do NOT test the IdP's discovery URL pinning here — that's a unit test
// for createOidcHandshake.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const SUBJECT = 'fake-subject-1';

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
  idp: StartedFakeIdp;
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

// The redirect_uri must EXACTLY match what we register at the IdP. Since
// the http listener picks a random port, we pre-bind, then re-create the
// auth plugin with the resolved port. Wrapping the boot logic this way
// keeps the test surface clean.
async function bootStackResolved(): Promise<BootedStack> {
  await dropTables();
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  // 1) Bind http first, in its own harness, just to discover a port.
  const probe = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const probeHarness = await createTestHarness({ plugins: [probe] });
  const port = probe.boundPort();
  await probeHarness.close({ onError: () => {} });

  // 2) Boot fake IdP.
  const idp = await startFakeIdp({
    clientId: 'fake-client-id',
    subject: SUBJECT,
    email: 'a@example.com',
    name: 'Test User',
  });

  // 3) Real boot at the resolved port.
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createAuthPlugin({
        providers: {
          google: {
            clientId: 'fake-client-id',
            clientSecret: 'fake-secret',
            issuer: idp.baseUrl,
            redirectUri: `http://127.0.0.1:${port}/auth/callback/google`,
          },
        },
      }),
    ],
  });

  return { harness, http, port, idp };
}

describe('@ax/auth OIDC handshake', () => {
  let stack: BootedStack;

  beforeEach(async () => {
    stack = await bootStackResolved();
  });

  afterEach(async () => {
    await stack.harness.close({ onError: () => {} });
    await stack.idp.close();
    await dropTables();
  });

  it('GET /auth/sign-in/google sets state cookie and 302s to IdP', async () => {
    const r = await fetch(`http://127.0.0.1:${stack.port}/auth/sign-in/google`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc).toMatch(new RegExp(`^${stack.idp.baseUrl}/authorize\\?`));
    // PKCE / state / nonce are stamped into the URL.
    const u = new URL(loc);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(u.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(u.searchParams.get('scope')).toContain('openid');
    // Set-Cookie carries the signed state cookie.
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${OIDC_STATE_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toMatch(/Max-Age=\d+/);
  });

  it('full happy-path: sign-in → IdP → callback → user + session row', async () => {
    // 1) Initiate sign-in; capture the state cookie + the IdP URL.
    const signIn = await fetch(
      `http://127.0.0.1:${stack.port}/auth/sign-in/google`,
      { redirect: 'manual' },
    );
    expect(signIn.status).toBe(302);
    const stateCookie = extractCookie(signIn, OIDC_STATE_COOKIE);
    expect(stateCookie).not.toBeNull();
    const idpUrl = signIn.headers.get('location')!;

    // 2) Hit the IdP's /authorize; it 302s back with code+state.
    const idpResp = await fetch(idpUrl, { redirect: 'manual' });
    expect(idpResp.status).toBe(302);
    const cb = idpResp.headers.get('location')!;
    expect(cb).toMatch(/\/auth\/callback\/google\?/);

    // 3) Hit our callback with the state cookie.
    const cbResp = await fetch(cb, {
      redirect: 'manual',
      headers: { cookie: `${OIDC_STATE_COOKIE}=${stateCookie}` },
    });
    expect(cbResp.status).toBe(302);
    expect(cbResp.headers.get('location')).toBe('/');
    // ax_auth_session cookie set, ax_oidc_state cleared.
    const setCookies = cbResp.headers.getSetCookie?.() ?? [
      cbResp.headers.get('set-cookie') ?? '',
    ];
    const session = setCookies.find((c) => c.startsWith('ax_auth_session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');

    // 4) Probe DB to assert the user + session rows landed.
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
      expect(users[0]!.auth_provider).toBe('google-oidc');
      expect(users[0]!.auth_subject_id).toBe(SUBJECT);
      // OIDC users default to non-admin (admin promotion is post-MVP).
      expect(users[0]!.is_admin).toBe(false);
      const sessions = await k
        .selectFrom('auth_v1_sessions')
        .select(['session_id', 'user_id'])
        .execute();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.user_id).toBe(users[0]!.user_id);
    } finally {
      await k.destroy().catch(() => {});
    }

    // 5) PKCE was actually checked on the IdP side.
    expect(stack.idp.pkceVerifiedOk()).toBe(true);
    expect(stack.idp.tokenCalls()).toBeGreaterThan(0);
  });

  it('second sign-in for the same sub does NOT duplicate the user row', async () => {
    // First handshake.
    const a1 = await fetch(
      `http://127.0.0.1:${stack.port}/auth/sign-in/google`,
      { redirect: 'manual' },
    );
    const c1 = extractCookie(a1, OIDC_STATE_COOKIE)!;
    const u1 = a1.headers.get('location')!;
    const r1 = await fetch(u1, { redirect: 'manual' });
    const cb1 = r1.headers.get('location')!;
    const ok1 = await fetch(cb1, {
      redirect: 'manual',
      headers: { cookie: `${OIDC_STATE_COOKIE}=${c1}` },
    });
    expect(ok1.status).toBe(302);

    // Second handshake (fresh state cookie).
    const a2 = await fetch(
      `http://127.0.0.1:${stack.port}/auth/sign-in/google`,
      { redirect: 'manual' },
    );
    const c2 = extractCookie(a2, OIDC_STATE_COOKIE)!;
    const u2 = a2.headers.get('location')!;
    const r2 = await fetch(u2, { redirect: 'manual' });
    const cb2 = r2.headers.get('location')!;
    const ok2 = await fetch(cb2, {
      redirect: 'manual',
      headers: { cookie: `${OIDC_STATE_COOKIE}=${c2}` },
    });
    expect(ok2.status).toBe(302);

    // Still ONE user row, but TWO session rows.
    const k = new Kysely<AuthDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const userCount = await k
        .selectFrom('auth_v1_users')
        .select(k.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(userCount.n)).toBe(1);
      const sessionCount = await k
        .selectFrom('auth_v1_sessions')
        .select(k.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(Number(sessionCount.n)).toBe(2);
    } finally {
      await k.destroy().catch(() => {});
    }
  });

  it('tampered state cookie → 400 callback-failed', async () => {
    const signIn = await fetch(
      `http://127.0.0.1:${stack.port}/auth/sign-in/google`,
      { redirect: 'manual' },
    );
    const goodCookie = extractCookie(signIn, OIDC_STATE_COOKIE)!;
    // Flip a single character in the signed payload — HMAC verify fails,
    // signedCookie returns null, handshake.finish throws.
    const tampered = flipChar(goodCookie);
    const idpUrl = signIn.headers.get('location')!;
    const idpResp = await fetch(idpUrl, { redirect: 'manual' });
    const cb = idpResp.headers.get('location')!;

    const cbResp = await fetch(cb, {
      redirect: 'manual',
      headers: { cookie: `${OIDC_STATE_COOKIE}=${tampered}` },
    });
    expect(cbResp.status).toBe(400);
    const body = (await cbResp.json()) as { error: string };
    // Generic error — we never echo the IdP's raw error.
    expect(body.error).toBe('callback-failed');
  });

  it('mismatched state in query → 400 callback-failed', async () => {
    const signIn = await fetch(
      `http://127.0.0.1:${stack.port}/auth/sign-in/google`,
      { redirect: 'manual' },
    );
    const cookie = extractCookie(signIn, OIDC_STATE_COOKIE)!;
    const idpUrl = signIn.headers.get('location')!;
    const idpResp = await fetch(idpUrl, { redirect: 'manual' });
    const cb = new URL(idpResp.headers.get('location')!);
    // Replace the state with a forged value while leaving the code intact.
    cb.searchParams.set('state', 'forged-state-value');

    const cbResp = await fetch(cb.toString(), {
      redirect: 'manual',
      headers: { cookie: `${OIDC_STATE_COOKIE}=${cookie}` },
    });
    expect(cbResp.status).toBe(400);
  });

  it('missing state cookie → 400 callback-failed', async () => {
    const signIn = await fetch(
      `http://127.0.0.1:${stack.port}/auth/sign-in/google`,
      { redirect: 'manual' },
    );
    const idpUrl = signIn.headers.get('location')!;
    const idpResp = await fetch(idpUrl, { redirect: 'manual' });
    const cb = idpResp.headers.get('location')!;
    // No cookie header — callback fires without the state cookie.
    const cbResp = await fetch(cb, { redirect: 'manual' });
    expect(cbResp.status).toBe(400);
  });
});

function extractCookie(resp: Response, name: string): string | null {
  const all = resp.headers.getSetCookie?.() ?? [
    resp.headers.get('set-cookie') ?? '',
  ];
  for (const line of all) {
    const m = line.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1] ?? null;
  }
  return null;
}

function flipChar(s: string): string {
  if (s.length === 0) return s;
  // Pick a character in the signed-value's payload (before the dot) and
  // bump it. Keeps the cookie syntactically a signed cookie but breaks
  // the HMAC.
  const dot = s.lastIndexOf('.');
  const idx = dot > 1 ? Math.floor(dot / 2) : 0;
  const ch = s.charCodeAt(idx);
  const replacement = String.fromCharCode(ch === 65 ? 66 : 65); // 'A' or 'B'
  return s.slice(0, idx) + replacement + s.slice(idx + 1);
}
