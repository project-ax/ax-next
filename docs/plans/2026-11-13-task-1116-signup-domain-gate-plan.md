# TASK-1116 Sign-up gate: close open sign-up, account pre-takeover, and the dead domain check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only an identity that Google or GitHub vouches for, with an email inside that provider's allowed domains, can create an ax account or sign in. The one exception: an admin the operator appointed can still sign in from outside the list. A sign-in never attaches to an account someone else could have set up.

**Architecture:** Everything lives in `@ax/auth-better` (better-auth 1.7.7 behind `/auth/*`). We turn off two sign-in doors nothing uses (email and password, and Google ID tokens posted by a client). We replace a path-sniffing check that never ran with one identity gate on better-auth's `user.validateUserInfo`, which runs on every account creation, account link and OAuth sign-in. We also remove the never-wired OIDC provider kind, and ship a tested, read-only audit SQL file plus a runbook for prod.

**Tech Stack:** TypeScript, better-auth 1.7.7, kysely, Postgres (Testcontainers in tests), vitest, jose (already a dependency), React + shadcn in `@ax/channel-web`.

**Spec:** The card (TASK-1116, "suspected open email sign-up + pre-account takeover") plus the "What we found" and "Design" sections below. The decisions, with rationale and rejected alternatives, are in `.claude/memory/decisions/2026-11-13-TASK-1116.md`. Read that first.

## Global Constraints

- better-auth stays pinned at `1.7.7`. **No new dependencies.** jose, pg, kysely, `@testcontainers/postgresql` and `better-auth/crypto` are already available to `@ax/auth-better`.
- **Never touch production or the GKE kubectl context.** The audit in Task 5 is for Vinay to run. If you need kind for anything, every `kubectl` names `--context kind-ax-next-dev`.
- Docker-backed tests need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. Set it for every whole-package run, channel-web's too: its `acceptance-e2e.test.ts` starts a container and fails without it. `--filter` goes before the script name: `pnpm --filter @ax/auth-better test <file-filter>`.
- Baseline on 6d9630adf (MEASURED by the planner): all of `@ax/auth-better` is green (17 files, 109 tests), and so is all of `@ax/channel-web` with `DOCKER_HOST` set (378 files, 7496 tests). `@ax/onboarding`, which creates the setup wizard's admin, is green too (11 files, 50 tests); keep it green, because it is the bootstrap path. Anything red that a task didn't touch is a regression.
- A refusal never echoes the email or the domain list. The one sentence a refused person sees is `REFUSAL_DESCRIPTION` = `This account can't sign in here. Ask your admin for help.` (ASCII apostrophe).
- Every test body is an inline arrow function, and no test passes a timeout argument. A hook may declare at most `60_000`, the package's `hookTimeout`. `scripts/hook-timeout-scan.mjs` reads a bare function reference as an unreadable budget and fails on a hook budget above the config.
- Memory rows go to shards: `target=$(scripts/memory-write-target.sh --shard <kind> TASK-1116); mkdir -p "$(dirname "$target")"`. Never write a root `.claude/memory/*.md` archive, and never name a zsh variable `path`. This card's decisions shard is `.claude/memory/decisions/2026-11-13-TASK-1116.md` (already exists; append to it).
- `pnpm test:scripts` runs `scripts/__tests__/memory-cited-paths-exist.test.js`, which fails on any backticked repo path in `.claude/memory/` that git doesn't track (MEASURED: it fails right now on the untracked plan file). **Commit this plan in the same commit as the decisions shard, or before it.** In a memory row, don't backtick a file path until the commit that creates the file; write the module name instead (e.g. "the `identity-gate` module").
- User-facing copy follows CLAUDE.md's voice: plain, short. UI changes stay inside the existing shadcn primitives (invariant 6). Invoke the `shadcn` skill before touching channel-web (no new component is expected).
- No hook signature or payload changes. If you find yourself adding or changing a hook, stop: this plan doesn't need one.

## Review Focus

1. **Case and spacing.** A list typed as ` CanopyWorks.com , partner.org ` and an email `Alice@CanopyWorks.COM` must be admitted. Test: Task 3, `decideIdentity` row "mixed case and spaces".
2. **Subdomains.** `bob@eng.canopyworks.com` is refused when the list is `canopyworks.com`, because matching is exact (to allow a subdomain, list it). Test: Task 3, row "subdomain". The audit's section 1 lists such accounts too (Task 5 seed `eng@eng.canopyworks.com`).
3. **An empty list means open, per provider.** A Google list says nothing about GitHub. Tests: Task 3, rows "open provider" and "per-provider lists".
4. **An admin outside the list.** The setup wizard's admin, or prod's only admin, may have an email off the provider's list, because wizard admins never went through the domain check. They must keep signing in, and a member with the same domain must not. Tests: Task 3, rows "off-list setup admin" and "off-domain admin sign-in"; Task 1, L4.
5. **A leftover `oidc` row, enabled or not.** It is listed and can be deleted. It can't be turned on, and it never reaches better-auth. Tests: Task 4, H1 and H2.

---

## What we found

MEASURED by the planner's throwaway spike: real better-auth 1.7.7, memory adapter, the handler's own config, fake Google/GitHub endpoints. (a), (b) and (c) were MEASURED again end to end on the real ax stack (test-harness + database-postgres + credentials + http-server + auth-better dist, postgres:16, Google `allowedDomains: canopyworks.com`) with exactly the harness Task 1 builds. `/admin/me` after the owner's Google sign-in returned the pre-registered id.

| # | Hole | Today |
|---|---|---|
| a | `POST /auth/sign-up/email` with any email | 200 and a user row (`mallory@evil.example`) |
| b | Pre-registered `victim@canopyworks.com` (attacker's password, unverified), then the owner's Google sign-in | linked: 302 `/`, session for the pre-registered id, accounts `credential,google`. The attacker's password still signs in (200, same id) |
| c | **The Google domain gate never runs.** `handler.ts:311` checks `context.path.includes('/callback/google')`, but better-auth 1.7.7 sets `path` to the route pattern (`dispatch.mjs:202`: the hook sees `/callback/:id`) | `outsider@evil.example` signs up through Google (302 `/`). An email Google marks unverified is admitted too |
| d | `POST /auth/sign-in/social {provider:'google', idToken}` | creates an off-domain user, 200 |
| e | `trustedProviders: ['google','github']` + GitHub's unverified primary email | a GitHub account with an UNVERIFIED copy of a teammate's email takes over their EXISTING account (302 `/`, accounts `google,github`) |
| f | An `oidc` provider row (the admin form offers "Generic OIDC") | `$context` rejects (`TypeError: socialProviders[key] is not a function`): every `/auth/*` 500s, and the next boot fails |

better-auth went to 1.7.7 in #1065 (2026-10-27) and has been deployed since rev 60 (2026-11-01; `acf2b75e7` is an ancestor of that deploy's `f95683db`), so prod has likely had (c) since then. On 1.6.x the check probably worked: `BACKLOG.md:24` records a live kind walk (PR #116) that hit its reject branch. (a) has been open since auth-better was scaffolded. **Prod is probably exposed right now.** The audit (Task 5) exists so Vinay can find out.

## Design

- **Off:** `emailAndPassword: { enabled: false }`. A typed email proves nothing without a verification mail, and we send none, so a domain check on email sign-up would still admit `anyone@canopyworks.com`. Nothing in the product uses it. Google gets `disableIdTokenSignIn: true` (GitHub has no ID-token sign-in in better-auth).
- **One gate** (`identity-gate.ts`, wired as `user.validateUserInfo`), refusing in this order:
  1. The method isn't `oauth`, or the provider isn't a configured google/github row → `sign_in_method_not_allowed`.
  2. The provider didn't assert a verified email → `email_not_verified`.
  3. The email's domain isn't in **that provider's** list (empty = open) → `email_domain_not_allowed`. This applies to create-user, link-account **and sign-in**, so off-domain member accounts made while the check was dead are refused at their next sign-in. One exception: on link-account and sign-in, an existing local user with role `admin` passes this rule. Admins are appointed by the operator (setup wizard or SQL), never admitted by sign-up, and the gate must not lock the operator out of their own install.
  4. `link-account` only: the existing local user must have a verified email, or be the setup wizard's admin before its first sign-in (role `admin`, zero accounts) → otherwise `account_not_linkable`.
- **Linking config:** drop `trustedProviders`, keep `requireLocalEmailVerified: false` (the gate enforces it, with the setup-admin exception better-auth can't express). `databaseHooks.user.create.before` keeps only the role override (`role: 'user'`).
- **Existing rows:** no migration. After the deploy, a pre-fix password is inert, a pre-registered unverified row can't be linked, and an off-domain account is refused at its next sign-in. Sessions already issued run out within 7 days.
- **OIDC:** removed from the form. The store refuses to add or enable it, though delete still accepts it. `loadProviders` skips it before decrypting.
- **Audit:** read-only SQL, run through psql in a one-shot pod (the `deploy/GKE.md` 4g pattern), tested against a real Postgres through psql.

Legit flows that must keep working (tests L1–L3, H2, existing suites):
- The setup wizard creates its admin with a direct insert (`auth:create-bootstrap-user`), then links the admin's first Google sign-in and lets it sign in again. An admin whose email is off the list keeps signing in.
- On-domain Google and GitHub sign-up and sign-in.
- A second provider with the same verified email links to the existing account.
- Admins can still manage google/github providers.
- `@ax/test-harness` `signInAsAdmin`.
- Kind walks that mint a session with SQL (the `deploy/MANUAL-ACCEPTANCE.md` headless recipe).

## File map

| File | Task | Change |
|---|---|---|
| `packages/auth-better/src/__tests__/support/fake-idp.ts` | 1 | new: fetch spy standing in for Google and GitHub, plus `oauthSignIn` |
| `packages/auth-better/src/__tests__/sign-up-gate.test.ts` | 1,2,3 | new: L1–L3 legit flows, A1–A9 holes |
| `packages/auth-better/src/handler.ts` | 2,3,4 | email/password off; Google ID tokens off; gate wiring; linking config; comments; `ProviderRow` narrowed |
| `packages/auth-better/src/plugin.ts` | 2,4 | bridge comment; `loadProviders` skips non-google/github before decrypt |
| `packages/auth-better/src/identity-gate.ts` | 3 | new: `decideIdentity`, `createIdentityGate`, moved `parseDomains`/`emailDomain` |
| `packages/auth-better/src/session-bridge.ts` | 3 | keeps only the ALS box |
| `packages/auth-better/src/providers-store.ts` | 4 | kind sets for add/enable vs delete |
| `packages/auth-better/src/__tests__/{account-linking,social-signin,malformed-host-rate-limit,hot-reload}.test.ts` | 2,3,4 | pins and fixes listed per task |
| `packages/auth-better/src/__tests__/identity-gate.test.ts` | 3 | new, Docker-free |
| `packages/auth-better/src/__tests__/session-bridge.test.ts` | 3 | deleted (cases move) |
| `packages/channel-web/src/{lib/auth-providers.ts,components/admin/AddProviderForm.tsx,components/admin/AuthProvidersTab.tsx,__tests__/admin-auth-providers.test.tsx}` | 4 | OIDC out |
| `packages/auth-better/sql/audit-sign-ups.sql` + `src/__tests__/audit-sign-ups-sql.test.ts` | 5 | new |
| `deploy/GKE.md` + `scripts/__tests__/auth-audit-runbook.test.js` | 5 | new section 4h (after 4g's closing `---`) and its context-pinning test |
| `deploy/charts/ax-next/SECURITY.md:465-466`, `.changeset/sign-up-gate.md`, memory shards | 6 | stale line, release note, memory |

---

### Task 1: Fake IdP harness and a confirmation of every hole [tier: sensitive]

**Files:**
- Create: `packages/auth-better/src/__tests__/support/fake-idp.ts`
- Create: `packages/auth-better/src/__tests__/sign-up-gate.test.ts`
- Modify: `.claude/memory/decisions/2026-11-13-TASK-1116.md` (append one row)

**Interfaces:**
- Produces (`support/fake-idp.ts`):
  ```ts
  export const GOOGLE_CLIENT_ID = 'test-google-client';
  export const GITHUB_CLIENT_ID = 'test-github-client';
  export interface GoogleIdentity { email: string; emailVerified: boolean; sub: string }
  export interface GithubIdentity { id: number; login: string; email: string; verified: boolean }
  export interface FakeIdp {
    nextGoogle(identity: GoogleIdentity): void;   // what Google token exchanges return from now on (sticky until the next call)
    nextGithub(identity: GithubIdentity): void;   // what GitHub user + emails calls return from now on (sticky)
    signGoogleIdToken(identity: GoogleIdentity): Promise<string>; // RS256, aud GOOGLE_CLIENT_ID, served by the fake JWKS
    restore(): void;
  }
  export function installFakeIdp(): Promise<FakeIdp>;
  export function freshClientIp(): string;        // a new valid IPv4 on every call
  export interface OAuthResult { status: number; location: string; setCookie: string; axSession: string | null }
  export function oauthSignIn(baseUrl: string, provider: 'google' | 'github'): Promise<OAuthResult>;
  ```

How the harness works. The better-auth side was MEASURED in the spike, which called `auth.handler` directly. The ax side (one joined Set-Cookie header, the `ax_auth_session` bridge) comes from reading `plugin.ts:770-815`.
- `installFakeIdp` captures the real `globalThis.fetch`, then `vi.spyOn(globalThis, 'fetch')`. Read the URL from a string, a `URL` or a `Request`. Prefix matches, in this order:
  - `https://oauth2.googleapis.com/token` → `Response.json({ access_token: 'fake-google-access', token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile', id_token })`. The `id_token` is a jose `UnsecuredJWT` of `{ email, email_verified, sub, name: 'Test' }` with issuer `https://accounts.google.com`, audience `GOOGLE_CLIENT_ID`, `setIssuedAt()`, `setExpirationTime('5m')`. better-auth's Google `getUserInfo` only decodes it. Throw if `nextGoogle` wasn't called.
  - `https://www.googleapis.com/oauth2/v3/certs` → `{ keys: [{ ...exportJWK(publicKey), kid: 'fake-google-key', alg: 'RS256', use: 'sig' }] }`, from a jose `generateKeyPair('RS256')` made once per install.
  - `https://github.com/login/oauth/access_token` → `{ access_token: 'fake-github-access', token_type: 'bearer', scope: 'read:user,user:email' }`.
  - `https://api.github.com/user/emails` (**match before `/user`**) → `[{ email, primary: true, verified, visibility: null }]`.
  - `https://api.github.com/user` → `{ id, login, name: login, email: null, avatar_url: null }`.
  - Any other `https:` URL throws `fake-idp: unexpected outbound fetch to <origin>`, so tests stay offline. Everything else goes to the real fetch, which covers the tests' own calls to 127.0.0.1.
- `oauthSignIn(baseUrl, provider)`:
  1. `POST ${baseUrl}/auth/sign-in/social` with headers `content-type: application/json`, `x-requested-with: ax-admin`, `x-forwarded-for: freshClientIp()`, body `{ provider, callbackURL: '/' }`. Anything but 200 throws with the body: that's a harness failure, never a refusal.
  2. `state` = `new URL(json.url).searchParams.get('state')`. The state cookie is `/ax_better_auth\.state=[^;,\s]+/` over `res.headers.getSetCookie().join('\n')`; ax joins every Set-Cookie into one header. Throw if either is missing.
  3. `GET ${baseUrl}/auth/callback/${provider}?code=fake-code&state=<encoded state>` with `redirect: 'manual'` and headers `cookie: <state pair>`, `x-forwarded-for: freshClientIp()`.
  4. Return `status`, `location` (`''` when absent), `setCookie` (joined), and `axSession` = the `/ax_auth_session=[^;,\s]+/` match or `null`. Drain the body.
- A fresh `X-Forwarded-For` per request matters. better-auth limits `/sign-in*` to 3 per 10 s per IP and path, keyed on a single-IP `X-Forwarded-For` (`@better-auth/core` `utils/ip.mjs`), and its limiter store is shared across the file.

`sign-up-gate.test.ts` setup:
- Copy `social-signin.test.ts`'s container, env (`AX_CREDENTIALS_KEY`, `AX_HTTP_ALLOW_NO_ORIGINS=1`), `dropTables` and `bootStack`. Call `signInAsAdmin({ bus, cookieKey, email: 'admin@canopyworks.com' })` and keep the returned user's `id` as `adminUserId`.
- One file-level Kysely on the container for DB assertions.
- `beforeEach`: `idp = await installFakeIdp()`, boot, then `addProvider('google', 'canopyworks.com')`. `afterEach`: `idp.restore()`, close the harness.
- Helpers (in the test file):
  - `addProvider(kind, allowedDomains)`: admin `POST /admin/auth/providers` with `{ kind, clientId: <matching *_CLIENT_ID>, clientSecret: 'test-secret', allowedDomains }`, expect 201.
  - `postJson(path, body)`: CSRF header plus a fresh XFF.
  - `insertPasswordUser(email): Promise<string>`: a user row with `email_verified false`, role `user`, plus a `credential` account. `account_id` is the user id and `password` is `await hashPassword(PASSWORD)` from `better-auth/crypto`. This is the row a pre-fix `/sign-up/email` left behind.
  - `insertGoogleUser(email, sub): Promise<string>`: `email_verified true` plus a `google` account with `account_id = sub`.
  - `countUsers(email)`, `providersOf(userId)` (sorted), `emailVerifiedOf(userId)`.
  - `me(axSession)`: `GET /admin/me` → `{ id, email, isAdmin }`.
- `const PASSWORD = 'correcthorsebattery'`.

- [ ] **Step 1: Write `support/fake-idp.ts`** to the interface above.

- [ ] **Step 2: Write the legit-flow tests as `it`**
  - **L1** `'a new canopyworks.com Google account signs up, signs in again as the same user, and gets only the ax_auth_session cookie'`
    - `nextGoogle({ email: 'alice@canopyworks.com', emailVerified: true, sub: 'g-alice' })`, then `r1 = oauthSignIn('google')`.
    - `r1.status === 302` and `r1.location` doesn't contain `/auth/error`.
    - `r1.axSession` isn't null, and `r1.setCookie` doesn't contain `ax_better_auth.session_token=`.
    - `me(r1.axSession).email === 'alice@canopyworks.com'`.
    - The same identity again: the second `me().id` equals the first.
    - `countUsers === 1`; `providersOf === ['google']`.
  - **L2** `"the setup wizard's admin links its first Google sign-in and stays admin"`
    - `nextGoogle({ email: 'admin@canopyworks.com', emailVerified: true, sub: 'g-admin' })`, then sign in: 302, `me().id === adminUserId`, `isAdmin === true`.
    - `emailVerifiedOf(adminUserId) === true`; `providersOf(adminUserId) === ['google']`.
    - A second sign-in gives the same id.
  - **L3** `'a verified GitHub email links to the existing account with that email'`
    - `addProvider('github', 'canopyworks.com')` and `insertGoogleUser('alice@canopyworks.com', 'g-alice')`.
    - `nextGithub({ id: 4242, login: 'alice', email: 'alice@canopyworks.com', verified: true })`, then sign in: 302 not to `/auth/error`, and `me().id` is alice's id.
    - `providersOf === ['github', 'google']`.
  - **L4** `'an admin whose email is outside the domain list still signs in'`
    - `bossId = insertGoogleUser('boss@partner.example', 'g-boss')`, then `UPDATE auth_better_v1_users SET role = 'admin' WHERE id = bossId`. This is an admin the operator appointed.
    - Same identity (verified): 302 not to `/auth/error`, `me().id === bossId`, `isAdmin === true`.

- [ ] **Step 3: Write the hole tests (temporarily as plain `it`)**
  - **A1** `'email and password sign-up is refused for any email'`
    - For `mallory@evil.example` and `bob@canopyworks.com`: `postJson('/auth/sign-up/email', { email, password: PASSWORD, name: 'X' })`.
    - Status 400, `json.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED'`, no `ax_auth_session=` in Set-Cookie, `countUsers(email) === 0`.
  - **A2** `'a password set before the fix no longer signs anyone in'`
    - `insertPasswordUser('victim@canopyworks.com')`, then `postJson('/auth/sign-in/email', { email, password: PASSWORD })`.
    - 400, `code === 'EMAIL_PASSWORD_DISABLED'`, no `ax_auth_session=`.
  - **A3** `'a Google ID token posted to /auth/sign-in/social is refused'`
    - `postJson('/auth/sign-in/social', { provider: 'google', idToken: { token: await idp.signGoogleIdToken({ email: 'idtoken@evil.example', emailVerified: true, sub: 'g-idtoken' }) } })`.
    - 404, `code === 'ID_TOKEN_NOT_SUPPORTED'`, `countUsers === 0`.
  - **A4** `'an off-domain Google account cannot sign up'`
    - `outsider@evil.example` (verified, `g-out`).
    - `location` contains `/auth/error?error=email_domain_not_allowed`, `axSession === null`, `countUsers === 0`.
  - **A5** `'a Google email that Google has not verified cannot sign up'`
    - `unverified@canopyworks.com`, `emailVerified: false`.
    - `location` contains `error=email_not_verified`, no session, no user.
  - **A6** `'a Google sign-in never attaches to an account someone pre-registered with a password'`
    - `id = insertPasswordUser('victim@canopyworks.com')`, then sign in as that email (verified, `g-victim`).
    - `location` contains `error=account_not_linkable`, `axSession === null`, `providersOf(id) === ['credential']`, `emailVerifiedOf(id) === false`.
  - **A7** `'an off-domain account made before the fix cannot sign in with Google any more'`
    - `insertGoogleUser('guest@evil.example', 'g-guest')`, then the same identity.
    - `location` contains `error=email_domain_not_allowed`, no session.
  - **A8** `"GitHub sign-up honours GitHub's own allowed domains"`
    - `addProvider('github', 'canopyworks.com')`, then `nextGithub({ id: 777, login: 'mal', email: 'mal@evil.example', verified: true })`.
    - `location` contains `error=email_domain_not_allowed`, `countUsers === 0`.
  - **A9** `'an unverified GitHub email never attaches to an existing account'`
    - `addProvider('github', 'canopyworks.com')`, `aliceId = insertGoogleUser('alice@canopyworks.com', 'g-alice')`, then `nextGithub({ id: 778, login: 'imp', email: 'alice@canopyworks.com', verified: false })`.
    - `location` contains `/auth/error?error=`, no session, `providersOf(aliceId) === ['google']`.

- [ ] **Step 4: Run on the unfixed code and read every failure**

  Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better test sign-up-gate`

  Expected: L1–L4 PASS. A1–A9 FAIL, each **at this assertion**. This is the spike's measurement of today's code:

  | Test | Today | First failing assertion |
  |---|---|---|
  | A1 | 200, user created | status 400 |
  | A2 | 200, signed in | status 400 |
  | A3 | 200, off-domain user + session | status 404 |
  | A4, A7, A8 | 302 to `/` with a session | location contains `error=email_domain_not_allowed` |
  | A5 | 302 to `/` | `error=email_not_verified` |
  | A6 | 302 to `/`, accounts `credential,google` | `error=account_not_linkable` |
  | A9 | 302 to `/`, accounts `github,google` | location contains `/auth/error?error=` |

  If a legit test fails, or a hole test fails for a harness reason, fix the harness and rerun. Harness reasons include an exception out of `oauthSignIn`, `unexpected outbound fetch`, a 429, or `state_mismatch`/`invalid_code` in a location. **If any of A1–A9 PASSES on unfixed code, STOP. Don't start Task 2.** Report back that the hole doesn't reproduce, so the card has to be narrowed.

- [ ] **Step 5: Mark A1–A9 `it.fails`**, each with a comment naming the task that flips it: `// TASK-1116: fails until Task 2` (A1–A3), `// TASK-1116: fails until Task 3` (A4–A9). Add one file-header comment: these are holes measured on the unfixed code, and `it.fails` goes red by itself if a hole stops reproducing. Rerun: all green.

- [ ] **Step 6: Append a MEASURED row** to `.claude/memory/decisions/2026-11-13-TASK-1116.md`: for each of A1–A9, the actual failing assertion and value you saw in Step 4.

- [ ] **Step 7: Commit**
  ```bash
  # if the plan and the shard aren't committed yet, they go in this commit together
  git add docs/plans/2026-11-13-task-1116-signup-domain-gate-plan.md packages/auth-better/src/__tests__/support/fake-idp.ts packages/auth-better/src/__tests__/sign-up-gate.test.ts .claude/memory/decisions/2026-11-13-TASK-1116.md
  git commit -m "test(auth-better): drive real OAuth callbacks and pin the open sign-up holes (TASK-1116)"
  ```

---

### Task 2: Turn off the sign-in doors nothing uses [tier: sensitive]

Flag: **security-checklist** (authentication boundary).

**Files:**
- Modify: `packages/auth-better/src/handler.ts:168-177` (Google entry), `:200` (`emailAndPassword`)
- Modify: `packages/auth-better/src/plugin.ts:784-786`. The comment says session-creating responses come from "OAuth callback / email sign-in or sign-up"; after this task it's only the OAuth callback.
- Modify: `packages/auth-better/src/__tests__/sign-up-gate.test.ts` (A1–A3 `it.fails` → `it`)
- Modify: `packages/auth-better/src/__tests__/account-linking.test.ts` (two pins)
- Modify: `packages/auth-better/src/__tests__/social-signin.test.ts:206-237` (delete the email bridge test)
- Modify: `packages/auth-better/src/__tests__/malformed-host-rate-limit.test.ts:217-240`

**Interfaces:** Consumes Task 1's harness. Produces nothing new.

- [ ] **Step 1: Failing tests.** Flip A1–A3 to `it`. In `account-linking.test.ts` add:
  - `'turns email and password sign-in off (TASK-1116)'`: `capturedConfigs[0].emailAndPassword` toEqual `{ enabled: false }`.
  - `'refuses Google ID tokens posted by a client (TASK-1116)'`: build with `providers: [{ kind: 'google', clientId: 'c', clientSecret: 's' }]`, then `socialProviders.google.disableIdTokenSignIn === true`.
- [ ] **Step 2: Run, expect FAIL.** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better test sign-up-gate account-linking`. A1–A3 and both pins fail.
- [ ] **Step 3: Implement.**
  - `emailAndPassword: { enabled: false }`. Drop `minPasswordLength`. Comment: off on purpose, TASK-1116. A typed email proves nothing without a verification mail (we send none), so it let anyone make an account and pre-claim a teammate's email. Nothing uses it: the setup wizard's admin has no password, and the login page is Google-only.
  - Google entry gets `disableIdTokenSignIn: true`, with a one-line comment: the login page uses the redirect flow; an ID token posted by a client skipped every check.
- [ ] **Step 4: Fix the two tests the change breaks.** Run the whole package after Step 3 and exactly these two go red; anything else red is a real regression.
  - `social-signin.test.ts`: delete `'email sign-in bridges better-auth session into a working ax_auth_session cookie'`. L1 now covers the bridge (`ax_auth_session` set, better-auth's own cookie dropped, `/admin/me` answers).
  - `malformed-host-rate-limit.test.ts`, `'a refused request never reaches the endpoint'`: a disabled sign-up throws before any query, so the control's `queries.length > 0` can't hold any more. Send both the refused request and the control as `requestWithHost(port, { method: 'GET', path: '/auth/callback/google?state=refused-state&code=refused-code', host })`; the callback looks the state up before anything else (`better-auth/dist/api/routes/callback.mjs:77`).
    - Refused (host `'marker five'`): 400, body `{ error: 'malformed-host' }`, `queries` equal `[]`, `authLines` equal one `'[ax/auth-better] bad request on GET /auth/* {"code":"malformed-host"}\n'`.
    - Control (well-formed host): `queries.length > 0`.
    - Update the comments that talk about sign-up.
- [ ] **Step 5: Update the `plugin.ts:784-786` comment.**
- [ ] **Step 6: Run the package.** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better test`, then `pnpm --filter @ax/auth-better build`. All green (A4–A9 still `it.fails`).
- [ ] **Step 7: Commit:** `fix(auth-better): turn off email/password and client-posted Google ID tokens (TASK-1116)`.

---

### Task 3: One identity gate for every OAuth sign-in [tier: sensitive]

Flag: **security-checklist** (authentication boundary, untrusted identity claims).

**Files:**
- Create: `packages/auth-better/src/identity-gate.ts`
- Create: `packages/auth-better/src/__tests__/identity-gate.test.ts` (Docker-free)
- Modify: `packages/auth-better/src/handler.ts`:
  - `:5` imports
  - `:190-192`: delete `googleAllowedDomains`
  - `:240-250`: `user.validateUserInfo`
  - `:251-280`: `accountLinking` and its comment
  - `:303-317`: `databaseHooks.user.create.before`
- Modify: `packages/auth-better/src/session-bridge.ts`. Remove `parseDomains`, `emailDomain`, `assertDomainAllowed` and the `APIError` import; it keeps only the ALS box.
- Delete: `packages/auth-better/src/__tests__/session-bridge.test.ts`. Its `parseDomains`/`emailDomain` cases move to `identity-gate.test.ts`; `decideIdentity` rows replace its `assertDomainAllowed` cases.
- Modify: `packages/auth-better/src/__tests__/account-linking.test.ts`
- Modify: `packages/auth-better/src/__tests__/sign-up-gate.test.ts` (A4–A9 → `it`)

**Interfaces:**
- Produces (`identity-gate.ts`):
  ```ts
  import type { BetterAuthOptions, ValidateUserInfoAction } from 'better-auth';
  export const REFUSAL_DESCRIPTION = "This account can't sign in here. Ask your admin for help.";
  export type IdentityRefusal = 'sign_in_method_not_allowed' | 'email_not_verified' | 'email_domain_not_allowed' | 'account_not_linkable';
  export interface IdentityAttempt { action: ValidateUserInfoAction; method: string; providerId: string | undefined; email: string; emailVerified: boolean }
  export interface LocalUserFacts { emailVerified: boolean; role: string; accountCount: number }
  export function parseDomains(raw: string | null | undefined): string[];   // moved from session-bridge.ts unchanged
  export function emailDomain(email: string): string;                       // moved unchanged
  export function decideIdentity(attempt: IdentityAttempt, allowedDomains: ReadonlyMap<string, readonly string[]>, local?: LocalUserFacts): IdentityRefusal | null;
  export function createIdentityGate(providers: ReadonlyArray<{ kind: string; allowedDomains?: string }>):
    NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;
  ```
  The structural `providers` type avoids a runtime import cycle with `handler.ts`.

`decideIdentity`, in this order:
1. `method !== 'oauth'`, or `providerId` undefined, or `!allowedDomains.has(providerId)` → `'sign_in_method_not_allowed'`.
2. `!emailVerified` → `'email_not_verified'`.
3. `list = allowedDomains.get(providerId)`; `list.length > 0 && !list.includes(emailDomain(email))` → `'email_domain_not_allowed'`, for **every** action. The only exception: `action !== 'create-user' && local?.role === 'admin'` passes this rule.
4. `action === 'link-account'`:
   - `local` undefined → `'account_not_linkable'`
   - `local.emailVerified` → `null`
   - `local.role === 'admin' && local.accountCount === 0` → `null` (the setup admin's first sign-in)
   - otherwise → `'account_not_linkable'`
5. → `null`.

`createIdentityGate`:
- Builds the map from the rows whose `kind` is `google` or `github` → `parseDomains(allowedDomains)`.
- Returns `async ({ user, source }, ctx) => …`. The attempt is: `action = source.action`, `method = source.method`, `providerId = source.oauth?.providerId`, `email = String(user.email ?? '')`, `emailVerified = user.emailVerified === true` (what the PROVIDER asserted).
- For `link-account` and `sign-in` (in both, better-auth passes the EXISTING local user's id as `user.id`), look up the local user: `ctx.context.internalAdapter.findUserById(String(user.id))`, then `findAccounts(id)`. `create-user` has no local user, so skip the lookup there. Read `role` as `String((u as { role?: unknown }).role ?? 'user')`. A missing user gives `local` undefined. Don't catch lookup errors; better-auth turns a throw into a 403 `validation_failed`, which fails closed.
- Return `{ error: refusal, errorDescription: REFUSAL_DESCRIPTION }`, or `undefined`.

- [ ] **Step 1: Failing tests.**
  - `identity-gate.test.ts`: move the `parseDomains`/`emailDomain` cases over verbatim, and add `decideIdentity` as `it.each` over the rows below. In every row: action `create-user`, method `oauth`, provider `google`, email `alice@canopyworks.com`, verified true, no `local`, Google list `['canopyworks.com']`, GitHub list `[]`, unless the row says otherwise. `local` is written `{emailVerified, role, accountCount}`.

    | Row | Change from default | Expect |
    |---|---|---|
    | on-domain create | create-user, `alice@canopyworks.com` | `null` |
    | off-domain create | create-user, `x@evil.example` | `email_domain_not_allowed` |
    | mixed case and spaces | list = `parseDomains(' CanopyWorks.com , partner.org ')`, `Alice@CanopyWorks.COM` | `null` |
    | subdomain | `bob@eng.canopyworks.com` | `email_domain_not_allowed` |
    | open provider | Google list `[]`, `x@anywhere.example` | `null` |
    | per-provider lists | provider `github`, GitHub list `['canopyworks.com']`, Google list `[]`, `x@evil.example` | `email_domain_not_allowed` |
    | unverified | verified false, `alice@canopyworks.com` | `email_not_verified` |
    | email/password | method `email-password`, provider undefined | `sign_in_method_not_allowed` |
    | unconfigured provider | provider `oidc` | `sign_in_method_not_allowed` |
    | off-domain sign-in | sign-in, `x@evil.example`, local `{true,'user',1}` | `email_domain_not_allowed` |
    | off-domain admin sign-in | sign-in, `boss@partner.example`, local `{true,'admin',1}` | `null` |
    | on-domain sign-in | sign-in, `alice@canopyworks.com`, local `{true,'user',1}` | `null` |
    | link to verified | link-account, local `{true,'user',1}` | `null` |
    | pre-registered | link-account, local `{false,'user',1}` | `account_not_linkable` |
    | setup admin first sign-in | link-account, `admin@canopyworks.com`, local `{false,'admin',0}` | `null` |
    | promoted pre-registered admin | link-account, local `{false,'admin',1}` | `account_not_linkable` |
    | user vanished | link-account, local undefined | `account_not_linkable` |
    | off-list setup admin | link-account, `admin@evil.example`, local `{false,'admin',0}` | `null` |
    | off-list admin is still unverified-checked | link-account, `admin@evil.example`, verified false, local `{false,'admin',0}` | `email_not_verified` |

  - `account-linking.test.ts`:
    - The trusted-providers test becomes `'trusts no provider to skip email verification (TASK-1116)'`: `accountLinking.trustedProviders` is `undefined`.
    - Keep the `requireLocalEmailVerified === false` assertion, but rewrite its comment: the gate enforces it, with the setup-admin exception.
    - Add `'gates every identity through user.validateUserInfo'`: `typeof user.validateUserInfo === 'function'`.
    - Delete `'does NOT trust generic oidc'` (nothing is trusted now).
  - `sign-up-gate.test.ts`: flip A4–A9 to `it`.
  - Run, expect FAIL: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better test identity-gate account-linking sign-up-gate`.
- [ ] **Step 2: Implement `identity-gate.ts`** to the interface and rules above. File header: why the gate exists (TASK-1116), and one line stating that `context.path` in better-auth 1.7 is the route pattern, so never gate on it.
- [ ] **Step 3: Wire it in `handler.ts`.**
  - `user.validateUserInfo: createIdentityGate(input.providers)`.
  - `accountLinking: { enabled: true, requireLocalEmailVerified: false }`. Rewrite comment `:257-275`: implicit linking stays on so the setup admin (no password, unverified email) can attach its first sign-in; `identity-gate.ts` decides who may link; no provider is trusted to skip email verification (GitHub returns unverified emails); `requireLocalEmailVerified` stays false only because better-auth can't make the setup-admin exception.
  - `databaseHooks.user.create.before: async (user) => ({ data: { ...user, role: 'user' } })`. Comment: every account better-auth creates is a member, and admins come only from the setup wizard. Who may create one at all is `identity-gate.ts`'s call, and it runs first. Don't gate on `context.path`: in better-auth 1.7 it's the route pattern (`/callback/:id`), which is how the old Google check silently never ran.
  - Remove `googleAllowedDomains` and the `parseDomains`/`assertDomainAllowed` import.
- [ ] **Step 4: Trim `session-bridge.ts`** and delete `session-bridge.test.ts`.
- [ ] **Step 5: Run the package.** `DOCKER_HOST=… pnpm --filter @ax/auth-better test`, then `pnpm --filter @ax/auth-better build`. All green, and `sign-up-gate` has no `it.fails` left.
- [ ] **Step 6: Grep.** `grep -rn "assertDomainAllowed\|callback/google\|trustedProviders" packages/auth-better/src --include='*.ts' | grep -v __tests__` prints nothing.
- [ ] **Step 7: Commit:** `fix(auth-better): one identity gate for sign-up, linking and sign-in (TASK-1116)`.

---

### Task 4: Remove the never-wired OIDC kind [tier: integration]

**Files:**
- Modify: `packages/auth-better/src/providers-store.ts:46,104,139-140,155-156,169-177`. Add/enable accept only `google`, `github` (message `kind must be one of google, github`). `delete` also accepts `oidc`, so a leftover row can be removed.
- Modify: `packages/auth-better/src/handler.ts:31-50`.
  - `ProviderRow.kind: 'google' | 'github'`; drop `discoveryUrl`.
  - New `allowedDomains` doc: comma-separated email domains this provider may let in, for sign-up and sign-in; empty = any account at the provider; enforced in `identity-gate.ts`.
  - Delete the `oidc` branch at `:178-187`, including the false "better-auth ignores unknown keys".
- Modify: `packages/auth-better/src/plugin.ts:443-485`. `loadProviders` skips any row whose kind isn't `google`/`github` **before** the `credentials:envelope-decrypt` call, and drops the `discovery_url` mapping.
- Modify: `packages/auth-better/src/__tests__/hot-reload.test.ts` (H1, H2)
- Modify: `packages/channel-web/src/lib/auth-providers.ts:15-31`.
  - `AuthProviderKind = 'google' | 'github'`.
  - `AuthProviderEntry.kind: string`, with a doc line: the server can still list an old kind the form no longer offers.
  - Drop `discoveryUrl` from `UpsertAuthProviderInput`.
  - `setAuthProviderEnabled(kind, …)` and `deleteAuthProvider(kind)` take `kind: string`; they act on listed rows, which may be a leftover kind.
- Modify: `packages/channel-web/src/components/admin/AddProviderForm.tsx`.
  - Remove `isOidc`, the `discoveryUrl` state, field and spread, and `<option value="oidc">`.
  - The kind hint becomes only `The service people will use to sign in.`
  - Header comment: drop the Discovery URL talk.
- Modify: `packages/channel-web/src/components/admin/AuthProvidersTab.tsx`.
  - Header comment `:5` → Google and GitHub.
  - `KIND_LABEL` without `oidc`, plus `labelFor(kind: string): string` (falls back to the raw kind), used at all seven `KIND_LABEL[...]` sites.
  - Empty state `:159-160` → `No identity providers configured. Add one to let users sign in with Google or GitHub.`
- Modify: `deploy/charts/ax-next/values.yaml:624-625`. The first-run comment says "add OIDC providers (Google, GitHub, generic)"; change it to "add a sign-in provider (Google or GitHub)".
- Modify: `packages/channel-web/src/__tests__/admin-auth-providers.test.tsx`.
  - Header item 5.
  - Replace `'discoveryUrl is hidden by default and shown when kind=oidc'` with `'offers only Google and GitHub'`: the Provider select's option values equal `['google', 'github']`, and there is no Discovery URL field.
  - Delete `'glosses Discovery URL by the names a provider’s docs actually use'`.
  - Keep `'says what leaving the domain allow-list blank actually means'` unchanged; its copy is now true.

**Interfaces:** Consumes Task 3's gate, which already ignores non-google/github kinds, and `freshClientIp` from Task 1.

- [ ] **Step 1: Failing tests** in `hot-reload.test.ts`:
  - **H1** `'refuses to add or turn on an oidc provider, which was never wired up'`
    - `POST /admin/auth/providers { kind: 'oidc', clientId: 'c', clientSecret: 's', discoveryUrl: 'https://idp.example/.well-known/openid-configuration' }` → 400, `error === 'invalid-payload'`.
    - `PATCH /admin/auth/providers/oidc { enabled: true }` → 400. Disabling an `oidc` row is refused too (the add/enable set covers PATCH). That's fine: the row is inert, and the way to clean it up is DELETE.
  - **H2** `"a leftover oidc row can't take sign-in down, and can still be deleted"`
    - Add Google through the route (201).
    - Get `ciphertext` from `stack.harness.bus.call('credentials:envelope-encrypt', ctx, { plaintext: 'leftover' })`.
    - Insert `auth_providers { kind: 'oidc', client_id: 'c', client_secret_encrypted: ciphertext, discovery_url: 'https://idp.example/.well-known/openid-configuration', allowed_domains: null, enabled: true, created_at, updated_at }`.
    - `await stack.harness.bus.fire('auth:providers-changed', ctx, {})`.
    - `POST /auth/sign-in/social { provider: 'google', callbackURL: '/' }` with a fresh `x-forwarded-for` → 200 and `url` matches `/accounts\.google\.com/` (today: 500 `auth-handler-failed`).
    - `DELETE /admin/auth/providers/oidc` → 204, and the oidc row count is 0.
    - `ctx` = `makeAgentContext({ sessionId: 'test', agentId: 'test', userId: 'system' })` from `@ax/core`.

  Then the channel-web test changes. Run both and expect FAIL:
  ```bash
  DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better test hot-reload
  pnpm --filter @ax/channel-web test admin-auth-providers
  ```
- [ ] **Step 2: Implement** the server changes, then the UI changes. Invoke the `shadcn` skill first, per CLAUDE.md.
- [ ] **Step 3: Run** both package suites, then `pnpm --filter @ax/auth-better build` and `pnpm --filter @ax/channel-web build` (channel-web's tsc does check its tests). All green.
- [ ] **Step 4: Commit:** `fix(auth-better,channel-web): drop the never-wired OIDC sign-in kind; a leftover row can't break sign-in (TASK-1116)`.

---

### Task 5: Read-only account audit and its runbook [tier: integration]

Flag: **security-checklist** (a script an operator runs against prod).

**Files:**
- Create: `packages/auth-better/sql/audit-sign-ups.sql`
- Create: `packages/auth-better/src/__tests__/audit-sign-ups-sql.test.ts` (pattern: `packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts`. It reads the real file, `container.copyContentToContainer`, then `container.exec(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'domain=canopyworks.com', '-U', …, '-d', …, '-f', '/tmp/audit.sql'])`.)
- Modify: `deploy/GKE.md`. New `### 4h. Audit accounts after TASK-1116 (sign-up gate)`.
  - Put it AFTER the `---` that closes 4g (`deploy/GKE.md:1101`) and before `## Step 5`, and end it with its own `---`.
  - Don't put it before that rule. `scripts/__tests__/run-error-scrub-runbook.test.js:146-151` treats everything from the 4g heading to the first `\n---\n` as 4g, and requires each ```text block there to hold exactly two `CREATE FUNCTION` lines.
  - 4h needs no ```text sample-output block.
- Create: `scripts/__tests__/auth-audit-runbook.test.js`, modelled on `run-error-scrub-runbook.test.js`. Slice 4h from its heading to the next `\n---\n`. Assert every fenced command line that runs `kubectl` carries `--context "$KCTX"`, and that the `--from-file=audit.sql=` path in it is a git-tracked file.

**The SQL file:**
- Guard: `\if :{?domain}` … `\else` `\echo 'Usage: psql -v domain=example.com -f audit-sign-ups.sql'` `\quit` `\endif`.
- Body: `BEGIN TRANSACTION READ ONLY;` … `ROLLBACK;`. Headers are `\echo` lines with exactly these texts, which the tests key on:
  - `== 0. Sign-in providers`: `kind, enabled, coalesce(allowed_domains, '(any domain)')`.
  - `== 1. Accounts outside the allowed domain`: users where `lower(substring(email from '@([^@]*)$')) IS DISTINCT FROM lower(:'domain')`.
  - `== 2. Accounts with a password (ax never sets one)`: users joined to their `credential` account.
    - Adds `password_set` and `first_provider_link`, the earliest non-credential account.
    - Adds `verdict`: `LINKED AFTER PASSWORD - treat as taken over` when a non-credential account was created at or after the password; otherwise `password only`.
  - `== 3. Unverified accounts (not counting a setup admin waiting for its first sign-in)`: `NOT email_verified AND NOT (role = 'admin' AND no accounts)`.
  - `== 4. Counts`: `outside_domain`, `with_password`, `taken_over`, `unverified`.
- Sections 1–3 list `id, email, role, email_verified, created_at`, `sign_in_methods` (provider ids by `created_at`, comma-joined, `(none)` when empty) and `live_sessions` (sessions with `expires_at > now()`).

**Steps:**
- [ ] **Step 1: Failing test.** Seed after `runAuthBetterMigration`:

  | Email | Row | Expected sections |
  |---|---|---|
  | `alice@canopyworks.com` | verified, google | none |
  | `Bob@CanopyWorks.COM` | verified, google | none (case-insensitive) |
  | `guest@gmail.example` | verified, google, one EXPIRED session | 1 (`live_sessions` 0) |
  | `eng@eng.canopyworks.com` | verified, google | 1 (subdomain) |
  | `pwonly@canopyworks.com` | unverified, credential | 2 `password only`, 3 |
  | `taken@canopyworks.com` | verified, credential at T, google at T+1 min | 2 `LINKED AFTER PASSWORD - treat as taken over`; not 3 |
  | `mallory@evil.example` | unverified, credential, one LIVE session | 1, 2 `password only`, 3 (`live_sessions` 1) |
  | `admin@canopyworks.com` | admin, unverified, no accounts | none |
  | `promoted@canopyworks.com` | admin, unverified, credential | 2, 3 |

  - **Test 1:** split the output on `== ` headers and assert each email shows up only in its sections, along with the verdict strings. Counts: `outside_domain` 3, `with_password` 4, `taken_over` 1, `unverified` 3. Exit code 0. Row counts of the four `auth_better_v1_*` tables and `auth_providers` are unchanged after the run.
  - **Test 2:** without `-v domain` the output contains `Usage:` and no `== 0.` header.
  - Run, expect FAIL (file missing): `DOCKER_HOST=… pnpm --filter @ax/auth-better test audit-sign-ups-sql`.
- [ ] **Step 2: Write the SQL.** Run: PASS.
- [ ] **Step 3: Write `scripts/__tests__/auth-audit-runbook.test.js` first.** Run `pnpm test:scripts`: it fails because there's no 4h yet.
- [ ] **Step 3b: Write GKE.md 4h** where the Files list says, modelled on 4g: the same `KCTX`/`NS` block, every `kubectl` naming `--context "$KCTX"`, and no ```text block. It's read-only, so it needs no backup step. Run `pnpm test:scripts`. Both runbook tests pass, and so does `memory-cited-paths-exist` once the plan is committed.
  - **What and when.** Run it now, before the TASK-1116 deploy, to see what the open sign-up let in. Then run it once after the deploy. It changes nothing: it runs in a read-only transaction and rolls back. **Its output names people.** Keep it out of tickets and chat, and record only the counts on the card.
  - **Load and run.**
    - Create configmap `auth-sign-up-audit` with `--from-file=audit.sql=packages/auth-better/sql/audit-sign-ups.sql` from a checkout that has the file.
    - Create pod `auth-sign-up-audit`: copy 4g Step 3's pod block, mount at `/sql`. psql line: `psql "${DATABASE_URL%%\?*}?sslmode=require" -X -v ON_ERROR_STOP=1 -v domain=canopyworks.com -f /sql/audit.sql`. Say "on another install, change that one value".
    - Wait for `Succeeded`, read the logs, delete the pod and the configmap.
  - **Reading it.** One short paragraph per section:
    - **0:** each enabled provider should show the domains you expect. `(any domain)` means anyone with an account there.
    - **1:** accounts whose email is outside the domain you passed with `-v domain`. The deploy refuses a member (role `user`) here at its next sign-in through a provider whose own list leaves its domain out. On canopyworks.ai, section 0 should show Google's list as exactly `canopyworks.com`, so that's every member here. Elsewhere, compare section 0: a provider showing `(any domain)` turns nobody away. Sessions already issued last up to 7 days. An admin here keeps access, because the list never turns an admin away. Decide whether each one should be an admin.
    - **2:** every row came through the old email sign-up, because nothing in ax sets a password. `LINKED AFTER PASSWORD` means someone set a password before the real owner's first Google/GitHub sign-in, and could sign in as them until this deploy. That's an incident: stop and ask a developer. `password only` means nobody can use it after the deploy, but it blocks the real owner's email until the row is removed.
    - **3:** these can't sign in after the deploy.
    - **4:** the numbers to record.
    - If sections 1–3 are empty, there's nothing to do. Otherwise, change no data without a developer.
- [ ] **Step 4: Commit** the SQL file, its test, `scripts/__tests__/auth-audit-runbook.test.js` and `deploy/GKE.md`: `feat(auth-better): read-only sign-up audit + GKE runbook 4h (TASK-1116)`.

---

### Task 6: Correct the stale security claim, release note, memory [tier: mechanical]

**Files:**
- Modify: `deploy/charts/ax-next/SECURITY.md:465-466`
- Modify: `BACKLOG.md:24` (one clause)
- Create: `.changeset/sign-up-gate.md`
- Create: patterns and context shards (paths from `scripts/memory-write-target.sh --shard patterns TASK-1116` and `--shard context TASK-1116`; `mkdir -p` each)
- Modify: `.claude/memory/decisions/2026-11-13-TASK-1116.md` (append the outcome row)

- [ ] **Step 1: SECURITY.md.** Replace lines 465-466 with exactly:
  ```markdown
  - **An artifact link is only as private as your sign-in rule (D10).**
    Anyone signed in to this AX install who has an artifact's link can open and download it, and can pass the link on. So a link is only as private as the rule for who can sign in. People sign in only through a sign-in provider (Google or GitHub); there's no email-and-password sign-up. If a provider lists allowed email domains, an account whose email (as that provider verifies it) is outside them can't sign up or sign in. The one exception is an admin the install's operator appointed. On canopyworks.ai the list is canopyworks.com, so that means teammates. With no list, it means anyone with an account at that provider. Until TASK-1116 this rule wasn't enforced: anyone could sign up with any email and a password, and the Google domain check didn't actually run. If your install is older than that, run the account audit in `deploy/GKE.md` (4h) once. Turn a link off or get a new one from the artifact's ⋯ menu; the old link stops working right away.
  ```
- [ ] **Step 1b: BACKLOG.md:24.** Its claim that the Google new-user allow branch "is unit-tested only" is no longer true. Change that clause to say a fake Google now drives it through the real handler (`packages/auth-better/src/__tests__/sign-up-gate.test.ts`, L1), and that a live walk with a real second Google account is still worth doing. Keep the item open.
- [ ] **Step 2: Changeset** `.changeset/sign-up-gate.md`, frontmatter `'@ax/auth-better': patch` and `'@ax/channel-web': patch`. Body: one paragraph saying what closed (email/password sign-up and sign-in, client-posted Google ID tokens, the dead domain check, GitHub's unverified-email link, the OIDC option) and that operators of older installs should run `deploy/GKE.md` 4h.
- [ ] **Step 3: Memory.**
  - Patterns shard, three rows:
    - better-auth 1.7's endpoint context `path` is the route pattern (`/callback/:id`), so never gate on it. Use `user.validateUserInfo` and its `source.oauth.providerId`.
    - To drive a real OAuth callback in a test, spy `fetch` for the provider's token endpoint. Google's callback only decodes the `id_token`, so an unsigned one works. Match `/user/emails` before `/user`.
    - Send a fresh `X-Forwarded-For` on every request, or better-auth's 3-per-10-s `/sign-in*` bucket trips.
  - Context shard, two rows:
    - Email/password and Google ID-token sign-in are off. A second user on kind comes from SQL (the `deploy/MANUAL-ACCEPTANCE.md` headless recipe), not `/auth/sign-up/email`.
    - The prod audit (GKE.md 4h) is PENDING: Vinay runs it.
  - Decisions shard: one outcome row (what shipped, the audit pending Vinay).
- [ ] **Step 4: Commit:** `docs(auth): correct the sign-up claim; changeset; TASK-1116 memory`.

---

## Before the PR

- [ ] `pnpm build` and `pnpm lint`.
- [ ] `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, the full three-suite gate. A local `@ax/auth-better` Docker-teardown timeout with every assertion passing is the known flake in CLAUDE.md. Rerun that package alone before calling it.
- [ ] Run the **`security-checklist`** skill over Tasks 1–5 and put its note in the PR. Hook boundary review is not needed: no hook signature or payload changes. Name the one contract change: `POST`/`PATCH /admin/auth/providers` now refuse `oidc`.
- [ ] PR body:
  - The MEASURED table above, and that prod has probably had (a) since the start and (c) since rev 60.
  - **Ask Vinay to run GKE.md 4h now, before merging/deploying.** It shows what the open sign-up let in, and which member accounts (section 1) lose access at the deploy.
  - The card's "Prod audit result recorded" acceptance item stays open for Vinay. The builder must not touch prod.

## Out of scope (record as follow-up cards, don't build)

- Nothing in `deploy/` or `container/` sets `NODE_ENV`, so `ax_auth_session` never gets `Secure` on prod (`plugin.ts:314,795`). UNCONFIRMED on the live host.
- better-auth's rate limiter trusts a single client-supplied `X-Forwarded-For`.
- The `role` additional field has no `input: false`. It's reachable only with better-auth's own session cookie, which the bridge never issues.
- `createBootstrapUser` stores the wizard email un-lowercased, so a mixed-case email can't link.
- A refused sign-in lands on better-auth's built-in error page, not an in-app message.
