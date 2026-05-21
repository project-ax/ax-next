# Google login (better-auth) integration — design

**Date:** 2026-05-20
**Status:** approved (brainstorm), pending implementation plan
**Plugin:** `@ax/auth-better` (+ client fix in `@ax/channel-web`)
**Branch:** `worktree-fix+google-login-better-auth` (off `origin/main`)

## 1. Problem

Clicking "Sign in with Google" 404s, then (after the client fix) 500s. There are three
layered defects, discovered by probing `kind-ax-next-dev`:

1. **Client path (already fixed in this branch).** `channel-web` navigated to
   `GET /auth/sign-in/google` — the deleted `@ax/auth-oidc` convention. better-auth 1.6.9
   has no such route; social sign-in is `POST /auth/sign-in/social` with `{ provider }` in
   the body, returning `{ url }` for the client to navigate to. → `GET …/google` 404s.

2. **better-auth has no schema (the real blocker).** `@ax/auth-better` configures
   better-auth with **default** model names (`user`, `session`, `account`, `verification`)
   but the migration only ever created `auth_better_v1_users`, `auth_better_v1_sessions`,
   `auth_providers`. better-auth's adapter tables were never created. Every path exercised
   so far (bootstrap via `auth:create-bootstrap-user`, `requireUser`, `/admin/me`,
   `/admin/sign-out`) is **hand-rolled Kysely against `auth_better_v1_*`, bypassing
   better-auth's adapter entirely**. The Google OAuth flow is the *first* code path that
   actually invokes better-auth's adapter, so it is the first to discover the missing
   tables — failing at `relation "verification" does not exist` (the OAuth-state write that
   precedes the redirect to Google).

3. **Split-brain identity store (lurks behind #2).** Even with the tables added,
   better-auth would write users/sessions into its *own* tables and set its *own* cookie
   (`better-auth.session_token`), while `requireUser` reads `auth_better_v1_sessions` keyed
   by the http-server-signed `ax_auth_session` cookie. A successful Google sign-in would
   still leave the user "logged out" from the app's perspective.

Ground truth (cluster DB): tables present are `auth_better_v1_users`,
`auth_better_v1_sessions`, `auth_providers` — none of `user`/`session`/`account`/`verification`.

## 2. Goal & scope

**In scope:** make Google social login work end-to-end — sign-in → Google consent →
callback → user/session in the existing tables → `ax_auth_session` cookie → logged in.

**Out of scope:**
- Email/password (also latently broken by the same root cause; no UI; deferred per `TODO.md`
  line 57). The remap incidentally unblocks it, but we do not wire or test it here.
- `github` / `oidc` provider kinds (config paths exist but are untested).
- Cross-provider account-linking policy beyond better-auth's default verified-email linking.

**Authorization policy (decided):** on a Google sign-in for an email with no existing ax
user, **auto-provision a `user`-role account only if the email domain matches the provider's
`allowed_domains`**; reject otherwise. When `allowed_domains` is empty/null, allow any
(open). This enforces a field the admin UI already presents (placeholder
`example.com, partner.com`) but which is currently inert.

## 3. Chosen approach — remap better-auth onto the existing tables + cookie bridge

The `auth_better_v1_*` tables were literally designed to mirror better-auth's user/session
shape (per the migration comments); better-auth was simply never told to use them. So we
point better-auth at the existing tables via config, add the two genuinely-missing tables,
and bridge the session cookie. End state: a **single** identity store and a **single**
session cookie.

Rejected alternatives:
- **B — parallel tables + mirror bridge:** two user tables and two session tables; violates
  invariant #4 (one source of truth). More moving parts, not fewer.
- **C — hand-roll OIDC with `openid-client`:** reverses PR #112, re-introduces deleted code,
  and puts the OAuth security surface (state/PKCE/nonce) back in our hands.

## 4. Invariants for this work

- **I1 — One source of truth (invariant #4).** Users and sessions live only in
  `auth_better_v1_users` / `auth_better_v1_sessions`. The only session cookie is
  `ax_auth_session`. No second user/session table.
- **I2 — Hand-rolled paths unchanged.** `auth:create-bootstrap-user`, `requireUser`,
  `auth:get-user`, `/admin/me`, `/admin/sign-out` are not modified. They keep reading/writing
  the same tables; the remap just makes better-auth write into those same tables too.
- **I3 — `role` is never trusted from provider/model input (invariant #5 / I5).**
  Provisioned Google users are forced to `role:'user'`. Only `auth:create-bootstrap-user`
  mints `admin`.
- **I4 — No half-wired window.** Client fix + backend ship in the same PR (invariant #3).
- **I5 — Hook surface unchanged.** No new/changed service-hook signatures; this is internal
  to `@ax/auth-better`. No boundary review required.
- **I6 — OAuth tokens encrypted at rest.** Google `access_token` / `refresh_token` /
  `id_token` are retained (we may call Google APIs as the user later) but MUST be encrypted at
  rest — never stored plaintext. Decryption stays inside better-auth so its internal token
  reads (e.g. refresh) still round-trip.

## 5. End-to-end flow

### Happy path (allowed user)
```text
click "Sign in with Google"
 → POST /auth/sign-in/social {provider:'google', callbackURL:'/'}      [client, done]
 → better-auth: write verification(state) → return { url }
 → browser → Google consent → Google 302 → GET /auth/callback/google?code&state
      better-auth: read+delete verification, exchange code, fetch userinfo
      databaseHooks.user.create.before: domain ∈ allowed_domains? else reject; force role:'user'
      write account(google↔user), user (if new), session  → all auth_better_v1_* (remap)
      databaseHooks.session.create.after: capture session.token (AsyncLocalStorage)
 → splat handler: re-issue token as http-server-signed ax_auth_session; drop better-auth cookie
 → 302 to '/'
 → browser sends ax_auth_session → requireUser finds the row → logged in
```

### Reject path (disallowed domain)
`user.create.before` throws → better-auth redirects to its error callback (`?error=…`) → the
login page renders a generic "this Google account isn't permitted" message. No user, no
account, no session created.

## 6. Schema changes

### 6.1 `handler.ts` — betterAuth config gains model→table mapping
```ts
user: {
  additionalFields: { role: { type: 'string', defaultValue: 'user' } },
  modelName: 'auth_better_v1_users',
  fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
},
session: {
  expiresIn: 7 * 24 * 60 * 60,
  modelName: 'auth_better_v1_sessions',
  fields: {
    userId: 'user_id', expiresAt: 'expires_at',
    ipAddress: 'ip_address', userAgent: 'user_agent',
    createdAt: 'created_at', updatedAt: 'updated_at',
  },
},
account: {
  modelName: 'auth_better_v1_accounts',
  fields: {
    userId: 'user_id', accountId: 'account_id', providerId: 'provider_id',
    accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
    accessTokenExpiresAt: 'access_token_expires_at',
    refreshTokenExpiresAt: 'refresh_token_expires_at',
    createdAt: 'created_at', updatedAt: 'updated_at',
  },
},
verification: {
  modelName: 'auth_better_v1_verifications',
  fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
},
```
The existing `auth_better_v1_users` / `auth_better_v1_sessions` columns satisfy better-auth's
NOT NULL / type expectations (verified 1:1 against the user/session model). `email`, `name`,
`image`, `token`, `scope`, `password`, `identifier`, `value`, `id` need no remap (names match).

### 6.2 `migrations.ts` — two additive `CREATE TABLE IF NOT EXISTS`
- `auth_better_v1_accounts`: `id` PK, `user_id` (FK→users ON DELETE CASCADE), `account_id`,
  `provider_id`, `access_token`, `refresh_token`, `id_token`, `access_token_expires_at`,
  `refresh_token_expires_at`, `scope`, `password`, `created_at`, `updated_at`. Unique index on
  `(provider_id, account_id)`. The three token columns hold **encrypted** values at rest (I6) —
  column type follows the chosen encryption mechanism (TEXT if better-auth native
  string-ciphertext; BYTEA if the envelope path is used).
- `auth_better_v1_verifications`: `id` PK, `identifier`, `value`, `expires_at`, `created_at`,
  `updated_at`. Index on `identifier`.

Forward-only, additive, matching the existing prefix + snake_case style. Add the table types
to the `AuthBetterDatabase` interface.

## 7. Authorization gate + role pinning

In `build()`, parse the Google provider's `allowed_domains` once per build (comma-separated →
trimmed, lowercased bare domains; `[]` when empty/null). Re-parsed automatically on
`auth:providers-changed` rebuild (the existing I10 seam), so admin edits take effect without
restart.

```ts
databaseHooks: {
  user: {
    create: {
      before: async (user) => {
        const domain = emailDomain(user.email);                    // after last '@', lowercased
        if (googleAllowedDomains.length > 0 && !googleAllowedDomains.includes(domain)) {
          throw new APIError('FORBIDDEN', { message: 'email domain not permitted' });
        }
        return { data: { ...user, role: 'user' } };                // never admin via Google
      },
    },
  },
}
```

- **Empty `allowed_domains` ⇒ open** (matches the optional UI field + chosen policy).
- **Gate fires only at user *creation*.** Already-provisioned users keep access if domains
  later tighten (gating is at provision time, consistent with the "no existing user" framing).
- The exact `APIError` import/shape better-auth expects from a `before` hook (so the throw
  becomes a clean callback-error redirect, not a 500) is verified by a test.

## 8. The cookie bridge

better-auth creates the session row (now in `auth_better_v1_sessions`) but sets its own
better-auth-signed cookie; `requireUser` reads the http-server-HMAC-signed `ax_auth_session`.
Bridge via `AsyncLocalStorage` so we never parse better-auth's cookie format.

```ts
// shared module within @ax/auth-better (NOT a cross-plugin import)
export const sessionTokenALS = new AsyncLocalStorage<{ token?: string }>();

// handler.ts databaseHooks.session.create.after:
after: async (session) => {
  const box = sessionTokenALS.getStore();
  if (box) box.token = session.token;      // raw token === auth_better_v1_sessions.token
}

// plugin.ts forwardToBetterAuth — wrap the better-auth invocation:
const box: { token?: string } = {};
const webResponse = await sessionTokenALS.run(box, () => handle.current()(new Request(url, init)));
// then, when copying response headers:
//   - drop any Set-Cookie whose name is better-auth's session cookie (name pinned via config)
//   - if box.token is set: res.setSignedCookie('ax_auth_session', box.token, opts)
```

- ALS context propagates through better-auth's internal awaits → `session.create.after` writes
  the same `box` the request created. Request-scoped, concurrency-safe.
- Strip better-auth's **session** cookie; **keep** its other cookies (e.g. state-cookie
  clearing on the callback). better-auth's session cookie name is pinned explicitly via config
  for deterministic detection (not guessed).
- `ax_auth_session` opts mirror `auth:complete-bootstrap-user`: `path:'/'`, `sameSite:'Lax'`,
  `secure` when `NODE_ENV==='production'`, `maxAge: sessionLifetimeSeconds`.
- This seam also lights up email/password sign-in for free (out of scope to test).

## 9. Error handling & edge cases

- **Disallowed domain** → `before` throws → better-auth error redirect; wire `errorCallbackURL`
  so the SPA renders a generic non-leaky message rather than a raw better-auth error page.
- **Provider not configured** → `POST /sign-in/social` returns 404 `PROVIDER_NOT_FOUND`; the
  client already throws on `!res.ok`. No 500.
- **`redirect_uri_mismatch` (Google)** → ops/config, not code: redirect URI is
  `${baseURL}/auth/callback/google` and must be registered in Google Cloud; `trustedOrigins`
  must include the serving origin (already plumbed from `AX_PUBLIC_BASE_URL`). Called out in
  manual-acceptance.
- **Account linking** → an email that already exists (e.g. bootstrap admin's gmail) links a
  `google` account to the existing user (verified email); no duplicate user. Desired.
- **Handler rebuild** → `auth:providers-changed` rebuilds and re-parses `allowed_domains`;
  cookie/ALS wiring is process-level and survives rebuilds.
- **Existing 500 path** → any better-auth handler throw still returns a generic 500 without
  leaking `err.message` (unchanged).

## 10. Testing

Per the bug-fix policy, the regression test that would have caught both bugs comes first.

- **`POST /auth/sign-in/social` returns `{ url }`, not 500** — with a google provider row
  (dummy creds) and the new tables migrated. Headline regression guard; fails today.
- **Migration** — `auth_better_v1_accounts` + `auth_better_v1_verifications` exist with
  expected columns.
- **Domain gate (unit)** — `before` rejects out-of-domain, allows in-domain, allows-all when
  empty, forces `role:'user'`.
- **Cookie bridge (unit)** — with the ALS box populated, the splat handler sets a signed
  `ax_auth_session` and strips better-auth's session cookie; `requireUser` then resolves it.
- **Client** — `auth-signInWithGoogle.test.ts` (already green): pins `POST /auth/sign-in/social`
  body + navigation.
- Runs in the existing `@ax/auth-better` test harness (real Postgres) + `channel-web` vitest.
  Full `pnpm build` + `pnpm test` + `pnpm lint` before PR.
- **Manual acceptance** — add a Google-sign-in walk to `deploy/MANUAL-ACCEPTANCE.md` and run it
  on `kind-ax-next-dev` with a real provider (the path PR #112 never walked). Playwright can
  drive it once the image carries the backend change; the Google consent screen needs real
  interaction.

**Half-wired window:** none — client + backend in one PR (invariant #3).

## 11. Security review

This touches auth, an untrusted-input boundary (Google-supplied email/profile → I5), new
tables, and the "who may provision an account" trust decision → **invoke the
`security-checklist` skill during implementation** and attach the note to the PR. Known items:
- **OAuth token storage (decided: keep + encrypt, I6)** — better-auth stores
  `access_token`/`refresh_token`/`id_token` in `account` in plaintext by default. We retain them
  but encrypt at rest. Mechanism, in preference order, verified during impl: (a) better-auth's
  native OAuth-token encryption option if 1.6.9 exposes one (decryption stays internal so token
  refresh round-trips); else (b) `databaseHooks.account.{create,update}.before` to
  envelope-encrypt + a read-side decrypt that keeps better-auth's internal reads on plaintext.
  Either path requires a **stable better-auth `secret`** (env-provided, distinct from the
  http-server cookie key) — also needed for OAuth state/verification integrity. The plan pins
  the secret source.
- **Domain gate is the authorization boundary** — provider/model input never sets `role`.
- **`trustedOrigins`** must be pinned in prod (not `['*']`) so better-auth's CSRF/origin check
  is real.
- **Error messages** don't reveal which emails exist or the precise rejection reason beyond a
  generic message.

## 12. Files touched

- `packages/auth-better/src/handler.ts` — model→table mapping, `databaseHooks`
  (user.create.before gate + session.create.after capture), pinned session-cookie name,
  `allowed_domains` parse, stable better-auth `secret`, OAuth-token at-rest encryption (I6).
- `packages/auth-better/src/migrations.ts` — two new tables + `AuthBetterDatabase` types.
- `packages/auth-better/src/plugin.ts` — wrap the better-auth call in `sessionTokenALS.run`,
  bridge `ax_auth_session`, strip better-auth's session cookie.
- `packages/auth-better/src/session-bridge.ts` (new) — the shared `AsyncLocalStorage` + small
  helpers (`parseDomains`, `emailDomain`).
- `packages/channel-web/src/lib/auth.ts` + `components/LoginPage.tsx` — client fix (done).
- `packages/channel-web/src/__tests__/auth-signInWithGoogle.test.ts` (done).
- `packages/auth-better/src/__tests__/*` — new backend tests.
- `deploy/MANUAL-ACCEPTANCE.md` — Google-sign-in walk.
