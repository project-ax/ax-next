// ---------------------------------------------------------------------------
// TASK-1116: who may get an ax account, and who may sign in to one.
//
// Drives the REAL better-auth handler through the whole ax stack (http-server,
// the ax_auth_session bridge, Postgres): `POST /auth/sign-in/social`, then the
// provider callback, with a fake Google and GitHub standing in for the real
// ones (support/fake-idp.ts).
//
// The first five are the sign-ins that must keep working. The rest are holes,
// each measured on the code before its fix: a completed sign-in where a refusal
// belongs (a 200 with a session, or a 302 to `/`). They landed as `it.fails`
// and the fix that closed each one flipped it to `it`.
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

  /**
   * A sign-in method already on an existing account: the row a pre-fix link left
   * behind, e.g. one `trustedProviders` let a GitHub account holding an
   * UNVERIFIED copy of the account's email make.
   */
  async function insertAccount(userId: string, provider: 'google' | 'github', accountId: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('auth_better_v1_accounts')
      .values({
        id: newId('acc'), user_id: userId, account_id: accountId, provider_id: provider,
        access_token: null, refresh_token: null, id_token: null,
        access_token_expires_at: null, refresh_token_expires_at: null, scope: 'read:user,user:email',
        password: null, created_at: now, updated_at: now,
      })
      .execute();
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

  it("a setup admin whose email is outside the domain list links its first Google sign-in", async () => {
    // The wizard never checked a domain, so prod's admin may be off the list.
    // Inserted as the wizard does: role admin, unverified, no sign-in method yet.
    const wizardId = newId('usr');
    const now = new Date();
    await db
      .insertInto('auth_better_v1_users')
      .values({ id: wizardId, email: 'wizard@partner.example', email_verified: false, name: 'Wizard', image: null, role: 'admin', created_at: now, updated_at: now })
      .execute();
    idp.nextGoogle({ email: 'wizard@partner.example', emailVerified: true, sub: 'g-wizard' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.status).toBe(302);
    expect(r.location).not.toContain('/auth/error');
    const who = await me(r.axSession);
    expect(who.id).toBe(wizardId);
    expect(who.isAdmin).toBe(true);
    expect(await providersOf(wizardId)).toEqual(['google']);
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

  it('an off-domain Google account cannot sign up', async () => {
    idp.nextGoogle({ email: 'outsider@evil.example', emailVerified: true, sub: 'g-out' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=email_domain_not_allowed');
    expect(r.axSession).toBeNull();
    expect(await countUsers('outsider@evil.example')).toBe(0);
    // A refusal names neither the email nor the allowed domains.
    expect(decodeURIComponent(r.location)).not.toContain('evil.example');
    expect(decodeURIComponent(r.location)).not.toContain('canopyworks');
  });

  it('a Google email that Google has not verified cannot sign up', async () => {
    idp.nextGoogle({ email: 'unverified@canopyworks.com', emailVerified: false, sub: 'g-unverified' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=email_not_verified');
    expect(r.axSession).toBeNull();
    expect(await countUsers('unverified@canopyworks.com')).toBe(0);
  });

  it('a Google sign-in never attaches to an account someone pre-registered with a password', async () => {
    const id = await insertPasswordUser('victim@canopyworks.com');
    idp.nextGoogle({ email: 'victim@canopyworks.com', emailVerified: true, sub: 'g-victim' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=account_not_linkable');
    expect(r.axSession).toBeNull();
    expect(await providersOf(id)).toEqual(['credential']);
    expect(await emailVerifiedOf(id)).toBe(false);
  });

  it('an off-domain account made before the fix cannot sign in with Google any more', async () => {
    await insertGoogleUser('guest@evil.example', 'g-guest');
    idp.nextGoogle({ email: 'guest@evil.example', emailVerified: true, sub: 'g-guest' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=email_domain_not_allowed');
    expect(r.axSession).toBeNull();
  });

  it("GitHub sign-up honours GitHub's own allowed domains", async () => {
    await addProvider('github', 'canopyworks.com');
    idp.nextGithub({ id: 777, login: 'mal', email: 'mal@evil.example', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=email_domain_not_allowed');
    expect(r.axSession).toBeNull();
    expect(await countUsers('mal@evil.example')).toBe(0);
  });

  it('an unverified GitHub email never attaches to an existing account', async () => {
    await addProvider('github', 'canopyworks.com');
    const aliceId = await insertGoogleUser('alice@canopyworks.com', 'g-alice');
    idp.nextGithub({ id: 778, login: 'imp', email: 'alice@canopyworks.com', verified: false });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=');
    expect(r.axSession).toBeNull();
    expect(await providersOf(aliceId)).toEqual(['google']);
  });

  it('a pre-registered account someone later made admin still never attaches to a Google sign-in', async () => {
    // Only the setup admin before its FIRST sign-in may link while unverified:
    // a row that already has a sign-in method (here, the pre-fix password) is
    // not waiting for one, whatever its role.
    const id = await insertPasswordUser('promoted@canopyworks.com');
    await db.updateTable('auth_better_v1_users').set({ role: 'admin' }).where('id', '=', id).execute();
    idp.nextGoogle({ email: 'promoted@canopyworks.com', emailVerified: true, sub: 'g-promoted' });
    const r = await oauthSignIn(stack.baseUrl, 'google');
    expect(r.location).toContain('/auth/error?error=account_not_linkable');
    expect(r.axSession).toBeNull();
    expect(await providersOf(id)).toEqual(['credential']);
  });

  // -- links made before the fix -----------------------------------------------
  //
  // Until TASK-1116, `trustedProviders` let a GitHub account holding an
  // UNVERIFIED copy of someone's email link into their account. The fix stops
  // new links like that, but the rows stay. On a later sign-in better-auth finds
  // the account by GitHub's id, not by email, and the link's holder can verify
  // an address of their own, so GitHub vouches for SOME email. Only the
  // account's own email tells them apart. (R1-R3: the whole-branch review's
  // reproductions, each a completed sign-in on the code before this rule.)

  it('a GitHub link made before the fix no longer opens the account when GitHub names another email (R1)', async () => {
    await addProvider('github', '');
    const aliceId = await insertGoogleUser('alice@canopyworks.com', 'g-alice');
    await insertAccount(aliceId, 'github', '779');
    idp.nextGithub({ id: 779, login: 'imp', email: 'imp@evil.example', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=email_mismatch');
    expect(r.axSession).toBeNull();
  });

  it("a GitHub link made before the fix can't open the setup admin's account from another email (R2)", async () => {
    // The domain list never turns an admin away, so the list alone can't stop this one.
    await addProvider('github', 'canopyworks.com');
    await insertAccount(stack.adminUserId, 'github', '780');
    idp.nextGithub({ id: 780, login: 'imp', email: 'imp@evil.example', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=email_mismatch');
    expect(r.axSession).toBeNull();
  });

  it("a member's leftover link is refused for its email before its domain (R3)", async () => {
    // Refused before the fix too, by the domain list. The email comes first now,
    // so the server log (and the error code) names what is actually wrong.
    await addProvider('github', 'canopyworks.com');
    const aliceId = await insertGoogleUser('alice@canopyworks.com', 'g-alice');
    await insertAccount(aliceId, 'github', '781');
    idp.nextGithub({ id: 781, login: 'imp', email: 'imp@evil.example', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.location).toContain('/auth/error?error=email_mismatch');
    expect(r.axSession).toBeNull();
  });

  it("a link made before the fix still signs in when GitHub vouches for the account's own email", async () => {
    // The owner proving their own address keeps working, whoever made the link.
    await addProvider('github', '');
    const aliceId = await insertGoogleUser('alice@canopyworks.com', 'g-alice');
    await insertAccount(aliceId, 'github', '782');
    idp.nextGithub({ id: 782, login: 'alice', email: 'Alice@CanopyWorks.com', verified: true });
    const r = await oauthSignIn(stack.baseUrl, 'github');
    expect(r.status).toBe(302);
    expect(r.location).not.toContain('/auth/error');
    expect((await me(r.axSession)).id).toBe(aliceId);
  });
});
