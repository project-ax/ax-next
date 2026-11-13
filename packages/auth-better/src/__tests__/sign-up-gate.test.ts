// ---------------------------------------------------------------------------
// TASK-1116: who may get an ax account, and who may sign in to one.
//
// Drives the REAL better-auth handler through the whole ax stack (http-server,
// the ax_auth_session bridge, Postgres): `POST /auth/sign-in/social`, then the
// provider callback, with a fake Google and GitHub standing in for the real
// ones (support/fake-idp.ts).
//
// L1-L4 are the sign-ins that must keep working. A1-A9 are holes measured on
// the unfixed code (6d9630adf). Each starts as `it.fails` and the task that
// closes it flips it to `it`. `it.fails` goes red by itself if a hole stops
// reproducing, so a fix that lands early (or a harness that quietly stops
// reaching better-auth) can't hide behind a passing suite.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { hashPassword } from 'better-auth/crypto';
import {
  createTestHarness,
  signInAsAdmin,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createHttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin } from '../plugin.js';
import type { AuthBetterDatabase } from '../migrations.js';
import {
  GITHUB_CLIENT_ID,
  GOOGLE_CLIENT_ID,
  freshClientIp,
  installFakeIdp,
  oauthSignIn,
  type FakeIdp,
} from './support/fake-idp.js';

const COOKIE_KEY = randomBytes(32);
/** Not a secret: the password a pre-fix `/auth/sign-up/email` would have stored. */
const PASSWORD = 'correcthorsebattery';
const ORIGINAL_CREDENTIALS_KEY = process.env.AX_CREDENTIALS_KEY;
const ORIGINAL_ALLOW_NO_ORIGINS = process.env.AX_HTTP_ALLOW_NO_ORIGINS;

let container: StartedPostgreSqlContainer;
let connectionString: string;
/** For assertions and fixtures, beside the stack's own pool. */
let db: Kysely<AuthBetterDatabase>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  db = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  process.env.AX_CREDENTIALS_KEY = randomBytes(32).toString('hex');
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
}, 60_000);

afterAll(async () => {
  await db?.destroy();
  if (container) await stopPostgresContainer(container);
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
  baseUrl: string;
  /** The setup wizard's admin (`admin@canopyworks.com`): role admin, unverified, no accounts. */
  adminCookie: string;
  adminUserId: string;
}

async function dropTables(): Promise<void> {
  await db.schema.dropTable('auth_providers').ifExists().execute();
  await db.schema.dropTable('auth_better_v1_verifications').ifExists().execute();
  await db.schema.dropTable('auth_better_v1_accounts').ifExists().execute();
  await db.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
  await db.schema.dropTable('auth_better_v1_users').ifExists().execute();
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
        const v = blobs.get((input as { ref: string }).ref);
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
  try {
    // The setup wizard's path: `auth:create-bootstrap-user` inserts the admin directly.
    const { cookieHeader, user } = await signInAsAdmin({
      bus: harness.bus,
      cookieKey: COOKIE_KEY,
      email: 'admin@canopyworks.com',
    });
    return {
      harness,
      baseUrl: `http://127.0.0.1:${http.boundPort()}`,
      adminCookie: cookieHeader,
      adminUserId: (user as { id: string }).id,
    };
  } catch (err) {
    await harness.close({ onError: () => {} });
    throw err;
  }
}

describe('@ax/auth-better: who may sign up and sign in (TASK-1116)', () => {
  let stack: BootedStack;
  let idp: FakeIdp;

  beforeEach(async () => {
    idp = await installFakeIdp();
    stack = await bootStack();
    await addProvider('google', 'canopyworks.com');
  });

  afterEach(async () => {
    idp?.restore();
    if (stack !== undefined) await stack.harness.close({ onError: () => {} });
  });

  // -- helpers ---------------------------------------------------------------

  async function addProvider(kind: 'google' | 'github', allowedDomains: string): Promise<void> {
    const res = await fetch(`${stack.baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: {
        cookie: stack.adminCookie,
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify({
        kind,
        clientId: kind === 'google' ? GOOGLE_CLIENT_ID : GITHUB_CLIENT_ID,
        clientSecret: 'test-secret',
        allowedDomains,
      }),
    });
    expect(res.status).toBe(201);
  }

  async function postJson(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; setCookie: string }> {
    const res = await fetch(`${stack.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
        'x-forwarded-for': freshClientIp(),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, setCookie: res.headers.getSetCookie().join('\n') };
  }

  function newId(prefix: string): string {
    return `${prefix}_${randomBytes(12).toString('hex')}`;
  }

  /** The row a pre-fix `POST /auth/sign-up/email` left behind: unverified, with a password. */
  async function insertPasswordUser(email: string): Promise<string> {
    const id = newId('usr');
    const now = new Date();
    await db
      .insertInto('auth_better_v1_users')
      .values({ id, email, email_verified: false, name: 'Pre-registered', image: null, role: 'user', created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('auth_better_v1_accounts')
      .values({
        id: newId('acc'), user_id: id, account_id: id, provider_id: 'credential',
        access_token: null, refresh_token: null, id_token: null,
        access_token_expires_at: null, refresh_token_expires_at: null, scope: null,
        password: await hashPassword(PASSWORD), created_at: now, updated_at: now,
      })
      .execute();
    return id;
  }

  /** A verified account that signed up with Google as `sub`. */
  async function insertGoogleUser(email: string, sub: string): Promise<string> {
    const id = newId('usr');
    const now = new Date();
    await db
      .insertInto('auth_better_v1_users')
      .values({ id, email, email_verified: true, name: 'Google user', image: null, role: 'user', created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('auth_better_v1_accounts')
      .values({
        id: newId('acc'), user_id: id, account_id: sub, provider_id: 'google',
        access_token: null, refresh_token: null, id_token: null,
        access_token_expires_at: null, refresh_token_expires_at: null, scope: 'openid,email,profile',
        password: null, created_at: now, updated_at: now,
      })
      .execute();
    return id;
  }

  async function countUsers(email: string): Promise<number> {
    const rows = await db.selectFrom('auth_better_v1_users').where('email', '=', email).select('id').execute();
    return rows.length;
  }

  async function providersOf(userId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('auth_better_v1_accounts')
      .where('user_id', '=', userId)
      .select('provider_id')
      .execute();
    return rows.map((r) => r.provider_id).sort();
  }

  async function emailVerifiedOf(userId: string): Promise<boolean | undefined> {
    const row = await db
      .selectFrom('auth_better_v1_users')
      .where('id', '=', userId)
      .select('email_verified')
      .executeTakeFirst();
    return row?.email_verified;
  }

  /** Who `/admin/me` says the session belongs to. */
  async function me(axSession: string | null): Promise<{ id: string; email: string; isAdmin: boolean }> {
    if (axSession === null) throw new Error('no ax_auth_session cookie was set');
    const res = await fetch(`${stack.baseUrl}/admin/me`, { headers: { cookie: axSession } });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string; email: string; isAdmin: boolean } };
    return { id: user.id, email: user.email, isAdmin: user.isAdmin };
  }

  // -- the sign-ins that must keep working -------------------------------------

  it('a new canopyworks.com Google account signs up, signs in again as the same user, and gets only the ax_auth_session cookie', async () => {
    idp.nextGoogle({ email: 'alice@canopyworks.com', emailVerified: true, sub: 'g-alice' });
    const r1 = await oauthSignIn(stack.baseUrl, 'google');
    expect(r1.status).toBe(302);
    expect(r1.location).not.toContain('/auth/error');
    expect(r1.axSession).not.toBeNull();
    expect(r1.setCookie).not.toContain('ax_better_auth.session_token=');
    const first = await me(r1.axSession);
    expect(first.email).toBe('alice@canopyworks.com');
    // Every account better-auth creates is a member.
    expect(first.isAdmin).toBe(false);

    const r2 = await oauthSignIn(stack.baseUrl, 'google');
    expect(r2.status).toBe(302);
    expect(r2.location).not.toContain('/auth/error');
    expect((await me(r2.axSession)).id).toBe(first.id);
    expect(await countUsers('alice@canopyworks.com')).toBe(1);
    expect(await providersOf(first.id)).toEqual(['google']);
  });

  it("the setup wizard's admin links its first Google sign-in and stays admin", async () => {
    idp.nextGoogle({ email: 'admin@canopyworks.com', emailVerified: true, sub: 'g-admin' });
    const r1 = await oauthSignIn(stack.baseUrl, 'google');
    expect(r1.status).toBe(302);
    expect(r1.location).not.toContain('/auth/error');
    const who = await me(r1.axSession);
    expect(who.id).toBe(stack.adminUserId);
    expect(who.isAdmin).toBe(true);
    expect(await emailVerifiedOf(stack.adminUserId)).toBe(true);
    expect(await providersOf(stack.adminUserId)).toEqual(['google']);

    const r2 = await oauthSignIn(stack.baseUrl, 'google');
    expect(r2.status).toBe(302);
    expect(r2.location).not.toContain('/auth/error');
    expect((await me(r2.axSession)).id).toBe(stack.adminUserId);
  });

  it('a verified GitHub email links to the existing account with that email', async () => {
    await addProvider('github', 'canopyworks.com');
    const aliceId = await insertGoogleUser('alice@canopyworks.com', 'g-alice');
    idp.nextGithub({ id: 4242, login: 'alice', email: 'alice@canopyworks.com', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.status).toBe(302);
    expect(r.location).not.toContain('/auth/error');
    expect((await me(r.axSession)).id).toBe(aliceId);
    expect(await providersOf(aliceId)).toEqual(['github', 'google']);
  });

  it('an admin whose email is outside the domain list still signs in', async () => {
    // An admin the operator appointed (setup wizard or SQL), never a sign-up.
    const bossId = await insertGoogleUser('boss@partner.example', 'g-boss');
    await db.updateTable('auth_better_v1_users').set({ role: 'admin' }).where('id', '=', bossId).execute();
    idp.nextGoogle({ email: 'boss@partner.example', emailVerified: true, sub: 'g-boss' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.status).toBe(302);
    expect(r.location).not.toContain('/auth/error');
    const who = await me(r.axSession);
    expect(who.id).toBe(bossId);
    expect(who.isAdmin).toBe(true);
  });

  // -- the holes ---------------------------------------------------------------

  it('email and password sign-up is refused for any email', async () => {
    for (const email of ['mallory@evil.example', 'bob@canopyworks.com']) {
      const r = await postJson('/auth/sign-up/email', { email, password: PASSWORD, name: 'X' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
      expect(r.setCookie).not.toContain('ax_auth_session=');
      expect(await countUsers(email)).toBe(0);
    }
  });

  it('a password set before the fix no longer signs anyone in', async () => {
    await insertPasswordUser('victim@canopyworks.com');
    const r = await postJson('/auth/sign-in/email', { email: 'victim@canopyworks.com', password: PASSWORD });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMAIL_PASSWORD_DISABLED');
    expect(r.setCookie).not.toContain('ax_auth_session=');
  });

  it('a Google ID token posted to /auth/sign-in/social is refused', async () => {
    const token = await idp.signGoogleIdToken({
      email: 'idtoken@evil.example',
      emailVerified: true,
      sub: 'g-idtoken',
    });
    const r = await postJson('/auth/sign-in/social', { provider: 'google', idToken: { token } });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ID_TOKEN_NOT_SUPPORTED');
    expect(r.setCookie).not.toContain('ax_auth_session=');
    expect(await countUsers('idtoken@evil.example')).toBe(0);
  });

  // TASK-1116: fails until Task 3
  it.fails('an off-domain Google account cannot sign up', async () => {
    idp.nextGoogle({ email: 'outsider@evil.example', emailVerified: true, sub: 'g-out' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=email_domain_not_allowed');
    expect(r.axSession).toBeNull();
    expect(await countUsers('outsider@evil.example')).toBe(0);
    // A refusal names neither the email nor the allowed domains.
    expect(decodeURIComponent(r.location)).not.toContain('evil.example');
    expect(decodeURIComponent(r.location)).not.toContain('canopyworks');
  });

  // TASK-1116: fails until Task 3
  it.fails('a Google email that Google has not verified cannot sign up', async () => {
    idp.nextGoogle({ email: 'unverified@canopyworks.com', emailVerified: false, sub: 'g-unverified' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=email_not_verified');
    expect(r.axSession).toBeNull();
    expect(await countUsers('unverified@canopyworks.com')).toBe(0);
  });

  // TASK-1116: fails until Task 3
  it.fails('a Google sign-in never attaches to an account someone pre-registered with a password', async () => {
    const id = await insertPasswordUser('victim@canopyworks.com');
    idp.nextGoogle({ email: 'victim@canopyworks.com', emailVerified: true, sub: 'g-victim' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=account_not_linkable');
    expect(r.axSession).toBeNull();
    expect(await providersOf(id)).toEqual(['credential']);
    expect(await emailVerifiedOf(id)).toBe(false);
  });

  // TASK-1116: fails until Task 3
  it.fails('an off-domain account made before the fix cannot sign in with Google any more', async () => {
    await insertGoogleUser('guest@evil.example', 'g-guest');
    idp.nextGoogle({ email: 'guest@evil.example', emailVerified: true, sub: 'g-guest' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=email_domain_not_allowed');
    expect(r.axSession).toBeNull();
  });

  // TASK-1116: fails until Task 3
  it.fails("GitHub sign-up honours GitHub's own allowed domains", async () => {
    await addProvider('github', 'canopyworks.com');
    idp.nextGithub({ id: 777, login: 'mal', email: 'mal@evil.example', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=email_domain_not_allowed');
    expect(r.axSession).toBeNull();
    expect(await countUsers('mal@evil.example')).toBe(0);
  });

  // TASK-1116: fails until Task 3
  it.fails('an unverified GitHub email never attaches to an existing account', async () => {
    await addProvider('github', 'canopyworks.com');
    const aliceId = await insertGoogleUser('alice@canopyworks.com', 'g-alice');
    idp.nextGithub({ id: 778, login: 'imp', email: 'alice@canopyworks.com', verified: false });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=');
    expect(r.axSession).toBeNull();
    expect(await providersOf(aliceId)).toEqual(['google']);
  });
});
