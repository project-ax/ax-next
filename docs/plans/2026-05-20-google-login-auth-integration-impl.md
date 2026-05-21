# Google login (better-auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Sign in with Google" work end-to-end by pointing better-auth at the existing `auth_better_v1_*` tables, adding the two missing adapter tables, gating provisioning by `allowed_domains`, and bridging better-auth's session to the http-server-signed `ax_auth_session` cookie.

**Architecture:** `@ax/auth-better` already hand-rolls bootstrap/session-check against `auth_better_v1_users` / `auth_better_v1_sessions`, bypassing better-auth's adapter. We remap better-auth's `user`/`session` models onto those tables (`modelName` + `fields`), add `auth_better_v1_accounts` + `auth_better_v1_verifications`, encrypt OAuth tokens at rest, gate Google provisioning to allowed domains (forcing `role:'user'`), and bridge the session token better-auth creates into `ax_auth_session` via `AsyncLocalStorage`. Net: one identity store, one session cookie; all existing paths unchanged.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`), better-auth 1.6.9, Kysely + Postgres, `@ax/http-server` (HMAC-signed cookies), vitest + `@testcontainers/postgresql`, pnpm monorepo.

**Spec:** `docs/plans/2026-05-20-google-login-auth-integration-design.md`

---

## File Structure

- `packages/auth-better/src/migrations.ts` — **modify**: add `auth_better_v1_accounts` + `auth_better_v1_verifications` tables + `AuthBetterDatabase` types.
- `packages/auth-better/src/session-bridge.ts` — **create**: pure helpers (`parseDomains`, `emailDomain`, `assertDomainAllowed`) + the shared `sessionTokenALS`.
- `packages/auth-better/src/handler.ts` — **modify**: model->table mapping, `account.encryptOAuthTokens`, `secret`, `advanced.cookiePrefix`, `databaseHooks` (gate + session-token capture); `HandlerInput` gains `secret?`; `ProviderRow` gains `allowedDomains?`.
- `packages/auth-better/src/plugin.ts` — **modify**: `AuthBetterConfig.secret`; thread `sessionCookieName`/lifetime + `secret`; carry `allowedDomains` in `loadProviders`; wrap better-auth call in `sessionTokenALS.run`; bridge `ax_auth_session`.
- `packages/auth-better/src/__tests__/migrations.test.ts` — **modify**: drop new tables in `afterEach`; assert new columns.
- `packages/auth-better/src/__tests__/session-bridge.test.ts` — **create**: unit tests for the pure helpers.
- `packages/auth-better/src/__tests__/social-signin.test.ts` — **create**: booted-stack integration (headline regression) + email cookie-bridge integration.
- `packages/channel-web/src/lib/auth.ts` + `components/LoginPage.tsx` + `__tests__/auth-signInWithGoogle.test.ts` — **already changed** on this branch (verify + commit).
- `presets/k8s/src/index.ts` — **modify**: read `AX_AUTH_SECRET`, plumb `AuthBetterConfig.secret`.
- `deploy/charts/ax-next/{values.yaml,templates/host/deployment.yaml,templates/hook-secret.yaml,__tests__/env-shape.test.ts}` — **modify**: add the better-auth secret env (from a k8s Secret).
- `deploy/MANUAL-ACCEPTANCE.md` — **modify**: add the Google sign-in walk.

> **Convention:** design/plan docs in `docs/plans/` are gitignored; commit with `git add -f` (matches the 34 existing tracked docs there).

---

## Task 1: Migration — account + verification tables

**Files:**
- Modify: `packages/auth-better/src/migrations.ts`
- Test: `packages/auth-better/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Update `afterEach` in `migrations.test.ts` to drop the new tables first (FK order)**

Replace the drop block inside `afterEach` so accounts/sessions drop before users:
```ts
      await k.schema.dropTable('auth_providers').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_verifications').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_accounts').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
      await k.schema.dropTable('auth_better_v1_users').ifExists().execute();
```

- [ ] **Step 2: Write the failing tests for the two new tables**

Add to the `describe('runAuthBetterMigration', ...)` block:
```ts
  it('creates auth_better_v1_accounts with the better-auth account columns', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'auth_better_v1_accounts'
      ORDER BY column_name`.execute(db);
    expect(result.rows.map((r) => r.column_name).sort()).toEqual(
      ['access_token','access_token_expires_at','account_id','created_at','id',
       'id_token','password','provider_id','refresh_token','refresh_token_expires_at',
       'scope','updated_at','user_id'].sort());
  });

  it('creates auth_better_v1_verifications with the better-auth verification columns', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'auth_better_v1_verifications'
      ORDER BY column_name`.execute(db);
    expect(result.rows.map((r) => r.column_name).sort()).toEqual(
      ['created_at','expires_at','id','identifier','updated_at','value'].sort());
  });

  it('accounts cascade-delete with their user', async () => {
    const db = makeKysely();
    await runAuthBetterMigration(db);
    const now = new Date();
    await db.insertInto('auth_better_v1_users').values({
      id:'u1', email:'a@example.com', email_verified:true, name:'A',
      image:null, role:'user', created_at:now, updated_at:now }).execute();
    await db.insertInto('auth_better_v1_accounts').values({
      id:'acc1', user_id:'u1', account_id:'g1', provider_id:'google',
      access_token:null, refresh_token:null, id_token:null,
      access_token_expires_at:null, refresh_token_expires_at:null,
      scope:null, password:null, created_at:now, updated_at:now }).execute();
    await db.deleteFrom('auth_better_v1_users').where('id','=','u1').execute();
    const remaining = await db.selectFrom('auth_better_v1_accounts').selectAll().execute();
    expect(remaining).toHaveLength(0);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/migrations.test.ts`
Expected: FAIL — `relation "auth_better_v1_accounts" does not exist`.

- [ ] **Step 4: Add the table types to `AuthBetterDatabase`**

Add after `auth_providers` in the `AuthBetterDatabase` interface:
```ts
  auth_better_v1_accounts: {
    id: string; user_id: string; account_id: string; provider_id: string;
    access_token: string | null; refresh_token: string | null; id_token: string | null;
    access_token_expires_at: Date | null; refresh_token_expires_at: Date | null;
    scope: string | null; password: string | null;
    created_at: Date; updated_at: Date;
  };
  auth_better_v1_verifications: {
    id: string; identifier: string; value: string; expires_at: Date;
    created_at: Date; updated_at: Date;
  };
```

- [ ] **Step 5: Add the CREATE TABLE statements**

After the `auth_providers` block in `runAuthBetterMigration`:
```ts
  await sql`
    CREATE TABLE IF NOT EXISTS auth_better_v1_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_better_v1_users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      access_token TEXT, refresh_token TEXT, id_token TEXT,
      access_token_expires_at TIMESTAMPTZ, refresh_token_expires_at TIMESTAMPTZ,
      scope TEXT, password TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS auth_better_v1_accounts_provider_account
      ON auth_better_v1_accounts (provider_id, account_id)`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS auth_better_v1_verifications (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL, value TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS auth_better_v1_verifications_identifier
      ON auth_better_v1_verifications (identifier)`.execute(db);
```
Token columns are TEXT — `encryptOAuthTokens` (Task 3) stores AES-256-GCM ciphertext as a string. Update the `migrations.ts` header comment to list the two new tables.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/auth-better/src/migrations.ts packages/auth-better/src/__tests__/migrations.test.ts
git commit -m "feat(auth-better): add account + verification tables for better-auth adapter"
```

---

## Task 2: session-bridge.ts — pure helpers + AsyncLocalStorage

**Files:**
- Create: `packages/auth-better/src/session-bridge.ts`
- Test: `packages/auth-better/src/__tests__/session-bridge.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `packages/auth-better/src/__tests__/session-bridge.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseDomains, emailDomain, assertDomainAllowed } from '../session-bridge.js';

describe('parseDomains', () => {
  it('splits comma-separated domains, trims + lowercases', () => {
    expect(parseDomains('Example.com, partner.org')).toEqual(['example.com','partner.org']);
  });
  it('returns [] for null/undefined/empty', () => {
    expect(parseDomains(null)).toEqual([]);
    expect(parseDomains(undefined)).toEqual([]);
    expect(parseDomains('   ')).toEqual([]);
  });
  it('drops empty entries from trailing/double commas', () => {
    expect(parseDomains('a.com,,b.com,')).toEqual(['a.com','b.com']);
  });
});

describe('emailDomain', () => {
  it('returns the lowercased domain after the last @', () => {
    expect(emailDomain('Alice@Example.COM')).toBe('example.com');
  });
  it('returns empty string when no @', () => {
    expect(emailDomain('garbage')).toBe('');
  });
});

describe('assertDomainAllowed', () => {
  it('allows any email when the list is empty (open)', () => {
    expect(() => assertDomainAllowed('x@anywhere.com', [])).not.toThrow();
  });
  it('allows an in-list domain', () => {
    expect(() => assertDomainAllowed('x@example.com', ['example.com'])).not.toThrow();
  });
  it('rejects an out-of-list domain', () => {
    expect(() => assertDomainAllowed('x@evil.com', ['example.com'])).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/session-bridge.test.ts`
Expected: FAIL — `Cannot find module '../session-bridge.js'`.

- [ ] **Step 3: Implement `session-bridge.ts`**

Create `packages/auth-better/src/session-bridge.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { APIError } from 'better-auth';

/**
 * Request-scoped carrier for the session token better-auth mints during a
 * sign-in flow. handler.ts's databaseHooks.session.create.after writes
 * box.token; plugin.ts's forwardToBetterAuth runs the better-auth call inside
 * sessionTokenALS.run(box, ...) and re-issues the token as the http-server-
 * signed ax_auth_session cookie. Keeps auth_better_v1_sessions + ax_auth_session
 * the single source of truth even though better-auth would set its own cookie.
 */
export const sessionTokenALS = new AsyncLocalStorage<{ token?: string }>();

/** Parse the provider's allowed_domains (comma-separated) into lowercased bare domains. */
export function parseDomains(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
}

/** Domain portion of an email (after the last @), lowercased; '' if malformed. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}

/**
 * Authorization gate for Google provisioning. Empty `allowed` => open. Throws
 * better-auth's APIError (FORBIDDEN) so a rejected sign-in becomes a clean
 * callback-error redirect, not a 500. Message is generic (never echoes the list).
 */
export function assertDomainAllowed(email: string, allowed: string[]): void {
  if (allowed.length === 0) return;
  if (!allowed.includes(emailDomain(email))) {
    throw new APIError('FORBIDDEN', { message: 'email domain not permitted' });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/session-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/auth-better/src/session-bridge.ts packages/auth-better/src/__tests__/session-bridge.test.ts
git commit -m "feat(auth-better): session-bridge helpers (domain gate + session-token ALS)"
```

---

## Task 3: handler.ts — model remap, token encryption, gate, session capture

**Files:**
- Modify: `packages/auth-better/src/handler.ts`
- Test: `packages/auth-better/src/__tests__/handler.test.ts`, `packages/auth-better/src/__tests__/social-signin.test.ts` (new)

- [ ] **Step 1: Write the headline integration test (booted stack)**

Create `packages/auth-better/src/__tests__/social-signin.test.ts`. Model the boot on `admin-routes.test.ts` (testcontainer + createTestHarness + database-postgres + credentials + http-server + auth-better; set `AX_CREDENTIALS_KEY` + `AX_HTTP_ALLOW_NO_ORIGINS` in beforeAll). Copy the EXACT request mechanism (`inject`/listen+fetch) and `signInAsAdmin` usage from `admin-routes.test.ts`; do not invent one. Then:
```ts
  it('POST /auth/sign-in/social returns a Google authorize url (not 500)', async () => {
    const adminCookie = await signInAsAdmin(stack.harness);
    const create = await stack.http.inject({
      method: 'POST', path: '/admin/auth/providers',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ kind: 'google', clientId: 'test-client-id', clientSecret: 'test-secret' }),
    });
    expect(create.statusCode).toBe(201);

    const res = await stack.http.inject({
      method: 'POST', path: '/auth/sign-in/social',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { url?: string }).url).toMatch(/accounts\.google\.com/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/social-signin.test.ts`
Expected: FAIL — status 500 (`relation "verification" does not exist`).

- [ ] **Step 3: Add the model->table mapping, token encryption, cookie prefix, secret, databaseHooks**

3a. Imports:
```ts
import { betterAuth } from 'better-auth';
import { parseDomains, assertDomainAllowed, sessionTokenALS } from './session-bridge.js';
```
3b. Add `secret?: string;` to `HandlerInput` (with a doc comment: stable secret for OAuth state + at-rest token encryption).
3c. Add `allowedDomains?: string;` to `ProviderRow`.
3d. In `build()`, before `betterAuth({...})`:
```ts
  const googleAllowedDomains = parseDomains(
    input.providers.find((p) => p.kind === 'google')?.allowedDomains,
  );
```
3e. Extend the `betterAuth({...})` options — add `secret`, the mapped models, `account.encryptOAuthTokens`, `verification`, `advanced.cookiePrefix`, `databaseHooks`. Ensure there is exactly ONE `session:` key (merge the existing `expiresIn` into the mapped block):
```ts
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    user: {
      additionalFields: { role: { type: 'string', defaultValue: 'user' } },
      modelName: 'auth_better_v1_users',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      modelName: 'auth_better_v1_sessions',
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address',
                userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    account: {
      modelName: 'auth_better_v1_accounts',
      encryptOAuthTokens: true,
      fields: { userId: 'user_id', accountId: 'account_id', providerId: 'provider_id',
                accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
                accessTokenExpiresAt: 'access_token_expires_at',
                refreshTokenExpiresAt: 'refresh_token_expires_at',
                createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    verification: {
      modelName: 'auth_better_v1_verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    advanced: { cookiePrefix: 'ax_better_auth' },
    databaseHooks: {
      user: { create: { before: async (user, context) => {
        if (context?.path?.includes('/callback/')) {
          assertDomainAllowed(String(user.email), googleAllowedDomains);
        }
        return { data: { ...user, role: 'user' } };
      } } },
      session: { create: { after: async (session) => {
        const box = sessionTokenALS.getStore();
        if (box) box.token = (session as { token: string }).token;
      } } },
    },
```
Keep the existing `auth.$context.catch(...)` and `return auth.handler;`. DELETE the now-duplicate standalone `session: { expiresIn: ... }` line.

> Gate scoping (refinement over spec section 7): the domain gate runs ONLY when `context.path` is an OAuth callback, so email/password creation (out of scope, no UI) is not subject to Google's `allowed_domains`.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/social-signin.test.ts`
Expected: PASS — status 200, url contains `accounts.google.com`.

- [ ] **Step 5: Run the existing handler construction tests (regression)**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/handler.test.ts`
Expected: PASS (construction/rebuild still build with the mapping; `ProviderRow.allowedDomains` is optional).

- [ ] **Step 6: Commit**

```bash
git add packages/auth-better/src/handler.ts packages/auth-better/src/__tests__/social-signin.test.ts
git commit -m "feat(auth-better): remap better-auth onto auth_better_v1_* tables + gate + token encryption"
```

---

## Task 4: plugin.ts — ALS wrap + cookie bridge + secret plumbing

**Files:**
- Modify: `packages/auth-better/src/plugin.ts`
- Test: `packages/auth-better/src/__tests__/social-signin.test.ts` (add email cookie-bridge case)

- [ ] **Step 1: Add the cookie-bridge integration test (no mock Google needed)**

Append to `social-signin.test.ts` (better-auth email sign-in exercises the SAME session.create.after + bridge + remap). Configure NO google provider here so the gate stays open:
```ts
  it('email sign-in bridges better-auth session into a working ax_auth_session cookie', async () => {
    const signUp = await stack.http.inject({
      method: 'POST', path: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correcthorsebattery', name: 'Member' }),
    });
    expect([200, 201]).toContain(signUp.statusCode);

    const signIn = await stack.http.inject({
      method: 'POST', path: '/auth/sign-in/email',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correcthorsebattery' }),
    });
    expect(signIn.statusCode).toBe(200);

    const setCookie = ([] as string[]).concat(signIn.headers['set-cookie'] ?? []).join('\n');
    expect(setCookie).toContain('ax_auth_session=');
    expect(setCookie).not.toContain('ax_better_auth.session_token=');

    const cookiePair = /ax_auth_session=[^;]+/.exec(setCookie)?.[0] ?? '';
    const me = await stack.http.inject({ method: 'GET', path: '/admin/me', headers: { cookie: cookiePair } });
    expect(me.statusCode).toBe(200);
    expect((JSON.parse(me.body) as { user?: { email?: string } }).user?.email).toBe('member@example.com');
  });
```
Adapt `set-cookie` access to the harness's response shape (may be a string or array).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/social-signin.test.ts`
Expected: FAIL — `set-cookie` has `ax_better_auth.session_token=`, not `ax_auth_session=`; `/admin/me` is 401.

- [ ] **Step 3: Add `secret` to config, carry `allowedDomains`, thread bridge params**

3a. Add to `AuthBetterConfig`:
```ts
  /**
   * Stable secret for the underlying better-auth instance (OAuth state +
   * at-rest OAuth-token encryption). MUST be stable across restarts or
   * encrypted tokens become undecryptable. Falls back to better-auth's
   * BETTER_AUTH_SECRET/AUTH_SECRET env read when omitted.
   */
  secret?: string;
```
3b. Capture next to `trustedOrigins`: `const secret = config.secret;`
3c. In `loadProviders`, push `allowedDomains` on each row:
```ts
        ...(r.allowed_domains !== null ? { allowedDomains: r.allowed_domains } : {}),
```
3d. Pass `secret` into `createBetterAuthHandler({...})` (init) and `localHandle.rebuild({...})` (the providers-changed subscriber), mirroring the `trustedOrigins` conditional spread:
```ts
        ...(secret !== undefined ? { secret } : {}),
```

- [ ] **Step 4: Wrap the better-auth call in the ALS and bridge the cookie**

Update the `/auth/*` splat call site to pass bridge opts:
```ts
        const handler = async (req: HttpRequest, res: HttpResponse): Promise<void> => {
          await forwardToBetterAuth(localHandle, req, res, { sessionCookieName, sessionLifetimeSeconds });
        };
```
Add the import + constant + rewrite `forwardToBetterAuth`:
```ts
import { sessionTokenALS } from './session-bridge.js';

// Pinned via advanced.cookiePrefix='ax_better_auth' in handler.ts. The bridge
// doesn't match on it (the box.token branch drops ALL better-auth cookies on
// a session-creating response); kept as a named constant so the coupling is explicit.
const BETTER_AUTH_SESSION_COOKIE = 'ax_better_auth.session_token';

interface BridgeOpts { sessionCookieName: string; sessionLifetimeSeconds: number; }

async function forwardToBetterAuth(
  handle: HandlerHandle, req: HttpRequest, res: HttpResponse, bridge: BridgeOpts,
): Promise<void> {
  const host = req.headers['host'] ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const queryString = serializeQuery(req.query);
  const url = `${proto}://${host}${req.path}${queryString.length > 0 ? `?${queryString}` : ''}`;

  const init: RequestInit = { method: req.method, headers: webHeadersFrom(req.headers) };
  if (req.method !== 'GET' && req.body.length > 0) {
    init.body = req.body as unknown as ArrayBuffer;
  }

  const box: { token?: string } = {};
  let webResponse: Response;
  try {
    webResponse = await sessionTokenALS.run(box, () => handle.current()(new Request(url, init)));
  } catch (err) {
    void err;
    process.stderr.write(`[ax/auth-better] handler error on ${req.method} ${req.path}\n`);
    res.status(500).json({ error: 'auth-handler-failed' });
    return;
  }

  res.status(webResponse.status);
  const setCookies = readSetCookies(webResponse.headers);
  for (const [name, value] of webResponse.headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') continue;
    res.header(name, value);
  }

  if (box.token !== undefined) {
    // Session-creating response (OAuth callback / email sign-in): re-issue the
    // session token as our http-server-signed cookie. better-auth's own
    // Set-Cookies on this response are intentionally dropped — its session
    // cookie is replaced by ours; its short-lived OAuth-state cookie self-expires.
    // (http-server writeHead() overwrites a header-map 'set-cookie' with the
    // setCookies[] array, so setSignedCookie alone yields the right wire output.)
    res.setSignedCookie(bridge.sessionCookieName, box.token, {
      path: '/', sameSite: 'Lax',
      ...(process.env['NODE_ENV'] === 'production' ? { secure: true } : {}),
      maxAge: bridge.sessionLifetimeSeconds,
    });
  } else if (setCookies.length > 0) {
    // Non-session responses (e.g. /sign-in/social sets the OAuth-state cookie):
    // forward better-auth's cookies unchanged.
    res.header('set-cookie', setCookies.join(', '));
  }

  const buf = Buffer.from(await webResponse.arrayBuffer());
  if (buf.length === 0) res.end();
  else res.body(buf);
}
```
If `BETTER_AUTH_SESSION_COOKIE` trips no-unused-vars, reference it in the comment via a `void BETTER_AUTH_SESSION_COOKIE;` is NOT acceptable — instead keep it only if the test imports it; otherwise inline the name in the comment and drop the constant. (The email-bridge test asserts the literal `ax_better_auth.session_token` is absent.)

- [ ] **Step 5: Run the integration tests to verify they pass**

Run: `pnpm --filter @ax/auth-better test -- --run src/__tests__/social-signin.test.ts`
Expected: PASS — both the social `{url}` case and the email cookie-bridge case.

- [ ] **Step 6: Run the full auth-better suite (regression)**

Run: `pnpm --filter @ax/auth-better test`
Expected: PASS — bootstrap, admin-routes, hot-reload, rate-limit, reset-cleanup, trusted-origins still green (the bridge only activates when better-auth mints a session).

- [ ] **Step 7: Commit**

```bash
git add packages/auth-better/src/plugin.ts packages/auth-better/src/__tests__/social-signin.test.ts
git commit -m "feat(auth-better): bridge better-auth session into ax_auth_session cookie + secret config"
```

---

## Task 5: Verify the client fix + commit it

**Files:** `packages/channel-web/src/lib/auth.ts`, `components/LoginPage.tsx`, `__tests__/auth-signInWithGoogle.test.ts` (already changed on this branch).

- [ ] **Step 1: Confirm the client changes are present**

Run: `git status --short && grep -n "sign-in/social" packages/channel-web/src/lib/auth.ts`
Expected: two modified files + the untracked test; `auth.ts` POSTs `/auth/sign-in/social`.

- [ ] **Step 2: Run the client test**

Run: `pnpm --filter @ax/channel-web test -- --run src/__tests__/auth-signInWithGoogle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit the client fix**

```bash
git add packages/channel-web/src/lib/auth.ts packages/channel-web/src/components/LoginPage.tsx packages/channel-web/src/__tests__/auth-signInWithGoogle.test.ts
git commit -m "fix(channel-web): POST /auth/sign-in/social for Google login (better-auth, not deleted auth-oidc)"
```

---

## Task 6: Plumb a stable better-auth secret through the preset + chart

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `deploy/charts/ax-next/values.yaml`, `templates/host/deployment.yaml`, `templates/hook-secret.yaml`
- Test: `deploy/charts/ax-next/__tests__/env-shape.test.ts`

- [ ] **Step 1: Read how the preset builds authBetterCfg + reads env**

Run: `sed -n '280,310p;520,540p;1000,1060p' presets/k8s/src/index.ts`
Expected: locate the `authBetterCfg` assembly (~533) and `loadK8sConfigFromEnv` `auth` section (~1000-1051) where `AX_PUBLIC_BASE_URL` -> `trustedOrigins`.

- [ ] **Step 2: Plumb `secret` in the preset (mirror trustedOrigins)**

- add `secret?: string;` to the `auth` config type (~301);
- in the `authBetterCfg` assembly (~533): `if (config.auth?.secret !== undefined) authBetterCfg.secret = config.auth.secret;`
- in `loadK8sConfigFromEnv` (~1000): `const authSecret = process.env['AX_AUTH_SECRET']; if (authSecret) auth.secret = authSecret;` with a comment that it must be stable across restarts (at-rest OAuth-token encryption).

- [ ] **Step 3: Update the env-shape test (failing first)**

Add `AX_AUTH_SECRET` to the expected env-var set in `deploy/charts/ax-next/__tests__/env-shape.test.ts` (follow the `AX_CREDENTIALS_KEY` pattern).
Run: `pnpm --filter @ax/preset-k8s test`
Expected: FAIL until Step 4.

- [ ] **Step 4: Wire the chart secret**

- `templates/hook-secret.yaml`: add an `AX_AUTH_SECRET` key, generate-if-absent (same pattern as `AX_CREDENTIALS_KEY`).
- `templates/host/deployment.yaml`: add an env entry sourcing `AX_AUTH_SECRET` from that Secret (mirror `AX_CREDENTIALS_KEY`).
- `values.yaml`: document it + any `existingSecret` override the chart already supports.

- [ ] **Step 5: Run the chart/preset tests**

Run: `pnpm --filter @ax/preset-k8s test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add presets/k8s/src/index.ts deploy/charts/ax-next
git commit -m "feat(preset-k8s): plumb stable AX_AUTH_SECRET for better-auth token encryption"
```

---

## Task 7: Manual-acceptance walk

**Files:** `deploy/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Add a Google sign-in scenario**

Document: (1) configure a Google provider in `/admin/auth` with real client ID/secret + an `allowed_domains` value; (2) ensure the Google Cloud OAuth client lists `${AX_PUBLIC_BASE_URL}/auth/callback/google` as an authorized redirect URI, and `AX_AUTH_SECRET` is set; (3) click "Sign in with Google"; (4) expect Google consent -> redirect back -> landed at `/` authenticated; (5) negative: an email outside `allowed_domains` lands back on the login page with the generic error. Note the Playwright caveat (consent screen needs real interaction/creds).

- [ ] **Step 2: Commit**

```bash
git add deploy/MANUAL-ACCEPTANCE.md
git commit -m "docs(acceptance): add Google sign-in walk"
```

---

## Task 8: Security checklist + full verification + PR

- [ ] **Step 1: Run the security-checklist skill**

Invoke `security-checklist` (touches auth, untrusted Google profile input, new tables, OAuth-token storage, provisioning trust). Attach the note to the PR. Confirm: tokens encrypted at rest (Task 3); `role` never trusted from input; `trustedOrigins` pinned in prod; generic error messages.

- [ ] **Step 2: Full build + test + lint**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: green across the repo (pre-PR gate: tsc-via-build + vitest + eslint).

- [ ] **Step 3: Open the PR**

Body: boundary-review note (no hook-surface change -> internal-only), the security note, the I1-I6 invariant audit (from the spec), and "Half-wired window: none — client + backend ship together." Include `pnpm --filter @ax/auth-better test` output.

```bash
git push -u origin worktree-fix+google-login-better-auth
gh pr create --title "fix: Google login via better-auth (schema remap + cookie bridge)" --body "..."
```

---

## Self-Review

**Spec coverage:** section 1 (layered defects) -> Tasks 1/3/4/5; section 3 (remap) -> Task 3; section 6 (schema) -> Tasks 1+3; section 7 (gate) -> Tasks 2+3 (path-scoped refinement); section 8 (cookie bridge) -> Tasks 2+4; section 9 (errors) -> covered (generic message, 404 client-handled, 500 path retained); section 10 (testing) -> Tasks 1-5; section 11 manual -> Task 7; section 11 security (I6 keep+encrypt) -> Task 3 encryptOAuthTokens + Task 6 stable secret + Task 8 checklist; section 12 files -> all mapped. Gap closed: spec didn't specify scoping the gate to OAuth-only; Task 3 Step 3e adds the `context.path` scope.

**Placeholder scan:** no TBD/TODO; every code step shows real code; the one `sed` step (Task 6 Step 1) is reconnaissance before exact edits whose shape is in Step 2.

**Type consistency:** `sessionTokenALS` (session-bridge) <-> handler + plugin; `ProviderRow.allowedDomains` added Task 3 <-> populated Task 4 Step 3c; `BridgeOpts`/`forwardToBetterAuth` signature <-> call site updated together; `ax_auth_session` (bridge) <-> `sessionCookieName` default <-> requireUser reader; `ax_better_auth` cookiePrefix <-> `ax_better_auth.session_token` constant <-> email-bridge test assertion.
