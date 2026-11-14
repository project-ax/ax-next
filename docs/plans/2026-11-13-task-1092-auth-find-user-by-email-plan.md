# TASK-1092: `auth:find-user-by-email` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One host-internal service hook on `@ax/auth-better`, `auth:find-user-by-email`: `{ email } → { userId } | null`. It lets `@ax/channel-slack` (TASK-1093/1094) route a Slack sender, by the email Slack verified, to the AX account that owns it.

**Architecture:** `@ax/auth-better` is the only plugin that owns users and the sign-in domain policy, so it registers the hook. The bus refuses a second registrant (`duplicate-service`). The lookup is one case-insensitive, otherwise exact SQL match on verified accounts. The matched account's email then has to pass the same domain predicate the Google sign-in gate uses. A strict zod `returns` schema makes sure nothing but the id ever leaves.

**Tech Stack:** TypeScript (exactOptionalPropertyTypes), Kysely on Postgres, zod 3 (`^3.23.8`), vitest + Testcontainers.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §1.2, §1.3, §6 ("Finding a user by verified email"), plus the TASK-1092 card. Planner decisions: `.claude/memory/decisions/2026-11-13-TASK-1092.md`. Stack decision: `.claude/memory/decisions/2026-11-12-TASK-1091.md`.

## Stacking and the half-wired window

This is the second PR of the stack 1091 → 1092 → 1093 → 1094. The stack merges as **one squash with TASK-1094** (TASK-1091 decisions shard). The first caller is TASK-1093 (`@ax/channel-slack`). No temporary caller and no preset change: `presets/k8s` already loads auth-better. The canary acceptance test drops auth-better and stubs the `auth:*` hooks (`presets/k8s/src/__tests__/acceptance.test.ts:145`, `:2617-2625`), so TASK-1093 adds an `auth:find-user-by-email` stub there along with channel-slack.

## What exists today (measured at d977151df)

- **Users:** `auth_better_v1_users` (`packages/auth-better/src/migrations.ts:70-79`). `email TEXT NOT NULL UNIQUE` is a **case-sensitive** unique. `email_verified BOOLEAN`.
- **One auth plugin:** `@ax/auth-oidc` was retired (2026-05-20). Nothing else registers `auth:*`.
- **Approved domains:** `auth_providers.allowed_domains` (comma-separated) on the `google` row. `parseDomains` + `assertDomainAllowed` (`session-bridge.ts:29-52`) gate **only** Google account creation (`handler.ts:306-314`). A blank list means anyone (`docs/plans/2026-05-20-google-login-auth-integration-design.md:51,183`). Production uses `canopyworks.com`.
- **Verified:** better-auth takes `emailVerified` from Google or GitHub. Linking flips it to `true` only when the stored email equals the provider's lowercased email (`better-auth/dist/oauth2/link-account.mjs:188`). The wizard admin is inserted with `email_verified: false` (`plugin.ts:643`). Email/password sign-ups are never verified, because no verification sender is configured. `update-user` refuses email changes and `change-email` is not enabled, so nobody can move a verified flag onto another address.
- **Case:** better-auth lowercases emails on sign-up and lookup (`better-auth/dist/db/internal-adapter.mjs:568-572`). `auth:create-bootstrap-user` stores the email exactly as typed (`plugin.ts:616-619`).
- **Pattern to copy:** `branding:get` registers with `{ returns }` (`packages/branding/src/plugin.ts:22`, `:72-79`). `auth:get-user` (`plugin.ts:282-286`) has no schema, and auth-better has no `zod` dependency yet.
- **IPC:** ipc-core dispatches only its explicit `ACTIONS` / `BINARY_ACTIONS` / `EVENTS` maps (`packages/ipc-core/src/dispatcher.ts`). `DISPATCHER_DEPENDENCIES` (`dependencies.ts`) lists every hook a handler can reach, and `dependency-sync.test.ts` scans the handlers to keep it honest. It holds no `auth:` hook. The only dynamic prefix is `tool:execute:`. A new service hook is therefore **not** an IPC action.

## Global Constraints

- Hook name `auth:find-user-by-email`. Input `{ email: string }`. Output `{ userId: string } | null`. Nothing else is returned: no email, name or admin flag.
- Host-internal only: no HTTP route, no IPC action, no `@ax/ipc-protocol` change.
- Match: SQL `lower(email) = lower(<input>)`. Never `LIKE`/`ILIKE` (they read `%` and `_` as wildcards). No trimming, no prefix or substring match.
- Verified means `email_verified = true`.
- Approved domains: `parseDomains()` of the `google` row's `allowed_domains`, **whether or not that row is enabled**. No row or a blank list means any domain, the same as sign-in. A domain matches exactly (a subdomain doesn't), through the one predicate the sign-in gate also uses.
- More than one verified match (accounts that differ only in case) returns `null` and logs the code-only warning `auth_find_user_by_email_ambiguous`.
- No email in any error message or log line.
- `zod` `^3.23.8` (the repo-wide range) resolves to the locked, patched `3.25.76`. The lockfile diff is the auth-better importer entry and nothing else.
- Put `--filter` before the script. Postgres tests need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`, spelled literally. For a single file, use `pnpm --filter <pkg> exec vitest run <file>`, not `test -- <file>`.
- Gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint` (with `DOCKER_HOST` set).
- The PR needs the boundary review (below) and a `security-checklist` note. Task 1 is an identity-mapping primitive at the Slack→AX trust boundary, it takes data from an external system (Slack), and it adds a `package.json` dependency.

## Review Focus

1. **Two verified accounts that differ only in case.** The unique index is case-sensitive and the wizard stores what was typed. Expect `null`, never "the first row" (Task 1, test 10).
2. **`%` or `_` in the email, or a later "simplify to ILIKE".** `%@canopyworks.com` must match nobody (Task 1, test 6 and the mutation step).
3. **Google sign-in disabled, or its list blank.** Disabling it must not widen who is found. A blank list behaves like sign-in: any domain (Task 1, tests 7–8).
4. **A subdomain of an approved domain** (`dave@eng.canopyworks.com`): `null`, the same as sign-in (Task 1, test 5).
5. **The email leaking through errors or logs.** The `invalid-payload` message is fixed text and the ambiguity warning is code-only (Task 1, test 11).

## Boundary review (paste into the PR)

- **Alternate impl:** an OIDC or SCIM directory, or a Google Workspace directory lookup, answering "which AX user owns this verified address".
- **Payload field names that might leak:** none (`email`, `userId`).
- **Subscriber risk:** none. This is a service hook with no subscribers. The caller contract: `null` deliberately doesn't say which rule failed (no account, unverified, off-domain, ambiguous). Callers must not read it as "not an employee", and must pass only an email they fetched from the identity provider themselves, never one taken from message text.
- **Wire surface:** none. Not an IPC action. Task 2 pins that no runner action reaches an `auth:` hook.
- **Timing and enumeration:** it tells whether an address has an AX account, but only to host code. No constant-time work: the caller only ever asks about the sender's own Slack-verified address.

## Out of scope (logged in the decisions shard, not built)

- An "is this email on an approved domain?" answer for Slack members with **no** AX account. TASK-1094 needs it for external admission (§2). Add it there, owned by auth. Never copy the domain list into channel-slack.
- A `lower(email)` index, caching the domain list, any HTTP surface.
- Two pre-existing auth findings for Vinay (decisions shard): email/password sign-up is open over the API, and the GitHub/OIDC domain lists aren't enforced.

---

### Task 1: `auth:find-user-by-email` in @ax/auth-better [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/auth-better/package.json` (dependencies: `"zod": "^3.23.8"`) and `pnpm-lock.yaml` (through `pnpm install`)
- Modify: `packages/auth-better/src/session-bridge.ts` (add `isDomainAllowed`; `assertDomainAllowed` delegates to it)
- Modify: `packages/auth-better/src/types.ts` (two types + contract comment)
- Modify: `packages/auth-better/src/index.ts` (export the two types)
- Modify: `packages/auth-better/src/plugin.ts` (manifest `registers`, output schema, `findUserByEmail` beside `getUserById`, `registerService` with `returns`)
- Test: `packages/auth-better/src/__tests__/session-bridge.test.ts`
- Test (new): `packages/auth-better/src/__tests__/find-user-by-email.test.ts`

**Interfaces:**
- Produces: the hook `auth:find-user-by-email`. `FindUserByEmailInput = { email: string }` and `FindUserByEmailOutput = { userId: string } | null`, exported from `@ax/auth-better`. TASK-1093 may `import type` them (`allowTypeImports: true`).
- Produces (plugin-internal): `isDomainAllowed(email: string, allowed: string[]): boolean` in `session-bridge.ts`. An empty list → `true`. Otherwise it is `allowed.includes(emailDomain(email))`.

- [ ] **Step 1: Write failing unit tests for `isDomainAllowed`** in `session-bridge.test.ts`, under `describe('isDomainAllowed')`:
  - `isDomainAllowed('x@anywhere.com', [])` → `true` (blank = open, as sign-in)
  - `isDomainAllowed('X@Example.COM', ['example.com'])` → `true`
  - `isDomainAllowed('x@evil.com', ['example.com'])` → `false`
  - `isDomainAllowed('x@eng.example.com', ['example.com'])` → `false` (exact domain)
  - `isDomainAllowed('garbage', ['example.com'])` → `false`

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/auth-better exec vitest run src/__tests__/session-bridge.test.ts`
  Expected: FAIL (`isDomainAllowed` is not exported).

- [ ] **Step 3: Implement `isDomainAllowed`**, and make `assertDomainAllowed` throw exactly when it returns `false`. The APIError and its `'email domain not permitted'` message stay the same.

- [ ] **Step 4: Run session-bridge tests**. Expected: PASS, including the existing `assertDomainAllowed` cases, unchanged.

- [ ] **Step 5: Write the failing contract tests** in `find-user-by-email.test.ts`.
  Harness: copy `dropTables` and `bootHarness` from `bootstrap-user.test.ts:41-108`, and boot per test as that file does.
  Add a seed helper that opens its own `Kysely` (`pg.Pool`, `max: 1`, destroyed in `finally`). It inserts user rows `{ id, email, email_verified, name: null, image: null, role: 'user', created_at, updated_at }` and, optionally, one `google` provider row `{ kind: 'google', client_id: 'cid', client_secret_encrypted: Buffer.from('x'), discovery_url: null, allowed_domains, enabled, created_at, updated_at }`. Insert **after** boot: the hook reads the table at call time, and init's `loadProviders` then never tries to decrypt the dummy secret.
  `find(email)` = `harness.bus.call<FindUserByEmailInput, FindUserByEmailOutput>('auth:find-user-by-email', harness.ctx(), { email })`.
  Unless a test says otherwise, it uses Google `allowed_domains: 'canopyworks.com'`, `enabled: true`.

  | # | Test name | Setup | Assertion |
  |---|---|---|---|
  | 1 | returns only the id for a verified email on an approved domain | `usr_alice` `alice@canopyworks.com` verified | `toEqual({ userId: 'usr_alice' })` and `Object.keys(r!)` equals `['userId']` |
  | 2 | returns null when no account has that email | as 1 | `find('zed@canopyworks.com')` → `null` |
  | 3 | matches case-insensitively in both directions | 1 + `usr_bob` `Bob@CanopyWorks.com` verified | `find('ALICE@CanopyWorks.COM')` → `usr_alice`. `find('bob@canopyworks.com')` → `usr_bob` |
  | 4 | an unverified email is never found: the wizard admin until a provider verifies it | `auth:create-bootstrap-user` `{ displayName: 'Admin', email: 'admin@canopyworks.com' }`, plus `usr_frank` `frank@canopyworks.com` unverified | admin → `null`, frank → `null`. Then `UPDATE … SET email_verified = true` on the admin → `{ userId: created.user.id }` |
  | 5 | an email on another domain is not found, including a subdomain | `usr_carol` `carol@gmail.com` and `usr_dave` `dave@eng.canopyworks.com`, both verified | both → `null` |
  | 6 | no wildcard, prefix or substring match | **no Google row** (open). `usr_alice` verified | each of `'%'`, `'%@canopyworks.com'`, `'_lice@canopyworks.com'`, `'lice@canopyworks.com'`, `'alice@canopyworks.co'`, `'alice@canopyworks.com.evil.org'`, `' alice@canopyworks.com'` → `null` |
  | 7 | with no approved domains configured, any verified domain is found, as at sign-in | `it.each`: no Google row / `allowed_domains: null` / `'  '`. `usr_carol` verified | `find('carol@gmail.com')` → `usr_carol` |
  | 8 | a disabled Google provider still limits the domains | Google `enabled: false`, `'canopyworks.com'`. `usr_alice` and `usr_carol` | carol → `null`, alice → `usr_alice` |
  | 9 | any domain in the comma-separated list is approved | `'canopyworks.com, Partner.ORG'`. `usr_alice`, `usr_pat` `pat@partner.org` | both found |
  | 10 | two verified accounts that differ only in case match nobody | `Erin@canopyworks.com` + `erin@canopyworks.com`, both verified | `find('erin@canopyworks.com')` and `find('ERIN@canopyworks.com')` → `null` |
  | 11 | rejects a malformed request without echoing it | — | `{}`, `{ email: 42 }`, `{ email: '' }` and `'x'.repeat(305) + '@canopyworks.com'` (321 chars) each reject with `PluginError` whose `code === 'invalid-payload'`, and the message doesn't contain `canopyworks`. `'x'.repeat(304) + '@canopyworks.com'` (320) resolves `null` |
  | 12 | registers with a strict returns schema: only `{ userId }` or `null` | `vi.spyOn(HookBus.prototype, 'registerService')` **before** `bootHarness()`, restored in `finally` | the call for `'auth:find-user-by-email'` has `opts.returns`. It `safeParse`s `{ userId: 'usr_x' }` ✓, `null` ✓, `{ userId: 'usr_x', email: 'a@b.c' }` ✗, `{ userId: '' }` ✗, `undefined` ✗ |

- [ ] **Step 6: Run them and see them fail**
  Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better exec vitest run src/__tests__/find-user-by-email.test.ts`
  Expected: FAIL (`no-service` for `auth:find-user-by-email`).

- [ ] **Step 7: Add the dependency.** Add `"zod": "^3.23.8"` to auth-better's `dependencies`, then run `pnpm install --prefer-offline`. Check: under the `packages/auth-better:` importer, `pnpm-lock.yaml` reads `version: 3.25.76(patch_hash=a34e0e2a71fa717a658b0d189816a520a345f27d0f68d1bc24c8c724aa91615d)`, and `git diff pnpm-lock.yaml` adds nothing outside that importer block. If anything else changes, stop: an unpatched zod would undo the GHSA-mrhx-c7xc-m3w5 patch.

- [ ] **Step 8: Types.** In `types.ts`, add `FindUserByEmailInput` and `FindUserByEmailOutput` with a contract comment every auth implementation must keep. The comment says: host-internal only; case-insensitive, otherwise exact; verified accounts only; approved sign-in domains only (blank = any); `null` for no match, for more than one match, or for any failed rule, and `null` never says which; returns only the id. Export both from `index.ts`.

- [ ] **Step 9: Implement in `plugin.ts`.**
  - Add `'auth:find-user-by-email'` to `manifest.registers`.
  - Add `const FindUserByEmailOutputSchema = z.object({ userId: z.string().min(1) }).strict().nullable();`
  - Add `async function findUserByEmail(db: Kysely<AuthBetterDatabase>, ctx: AgentContext, input: FindUserByEmailInput): Promise<FindUserByEmailOutput>` next to `getUserById`, doing these steps in order:
    1. `input?.email` must be a string of 1–320 characters (`MAX_EMAIL_LEN`). Otherwise throw `PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, hookName: 'auth:find-user-by-email', message: 'email must be a non-empty string of at most 320 characters' })`.
    2. Select `id` and `email` from `auth_better_v1_users` where `lower(email) = lower(<input>)` and `email_verified = true`, with `limit(2)`.
    3. 0 rows → `null`. 2 rows → `ctx.logger.warn('auth_find_user_by_email_ambiguous', { matches: 2 })`, then `null`.
    4. 1 row → read `allowed_domains` from `auth_providers` where `kind = 'google'` (no `enabled` filter). Return `isDomainAllowed(row.email, parseDomains(value))` ? `{ userId: row.id }` : `null`. The **stored** email is the one checked.
  - Register it after `auth:get-user`: `bus.registerService<FindUserByEmailInput, FindUserByEmailOutput>('auth:find-user-by-email', PLUGIN_NAME, (ctx, input) => findUserByEmail(localDb, ctx, input), { returns: FindUserByEmailOutputSchema })`.
  - Update the "What's new" header comment's hook list.

- [ ] **Step 10: Run tests and build**
  Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/auth-better test && pnpm --filter @ax/auth-better build`
  Expected: all files PASS (the existing suites included), and `tsc --build` exits 0.

- [ ] **Step 11: Mutation spot-check.** Predict which test goes red, apply the mutant, confirm it does, revert it:
  - drop `email_verified = true` → test 4
  - `lower(email) = lower(x)` → `email ILIKE x` → test 6
  - take the first of 2 rows → test 10
  - filter the Google row by `enabled = true` → test 8
  - drop `.strict()` → test 12
  - a domain check that treats a blank list as closed → test 7

- [ ] **Step 12: Commit**
```bash
git add packages/auth-better pnpm-lock.yaml
git commit -m "feat(auth-better): auth:find-user-by-email, a host-internal verified-email lookup (TASK-1092)"
```

### Task 2: Pin "never an IPC action" in ipc-core [tier: mechanical]

**Files:**
- Modify: `packages/ipc-core/src/__tests__/dependencies.test.ts`

**Interfaces:**
- Consumes: `DISPATCHER_DEPENDENCIES` (`requiredCalls`, `optionalCalls[].hook`, `dynamicCallPatterns`), as that file already imports.

- [ ] **Step 1: Add the test** `it('reaches no auth: hook, so the user directory stays host-internal (channel-slack design §6)')`. It collects every required hook, every optional hook and every dynamic prefix, and asserts `hooks.filter((h) => h.startsWith('auth:'))` equals `[]`. A comment explains why this covers every handler: `dependency-sync.test.ts` fails any handler whose `bus.call` / `bus.hasService` isn't listed here.

- [ ] **Step 2: Prove it can fail, then that it passes.** Temporarily add `'auth:find-user-by-email'` to `requiredCalls` and confirm the test goes red. Revert, then run `pnpm --filter @ax/ipc-core exec vitest run src/__tests__/dependencies.test.ts src/__tests__/dependency-sync.test.ts`. Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add packages/ipc-core/src/__tests__/dependencies.test.ts
git commit -m "test(ipc-core): no runner action reaches an auth: hook (TASK-1092)"
```

### Task 3: Correct the design doc's domain and hook lines [tier: mechanical]

Rule-5 fix: these lines made the card read as "one approved domain" and called its callers "Tier-3 attended turns". No tier like that is defined anywhere. In this doc, Tier 2 and Tier 3 are Slack's API rate tiers.

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:22-26` (§1.2) and `:312-322` (§6)

**Interfaces:**
- Consumes: the as-built contract from Task 1 (Global Constraints).

- [ ] **Step 1: §1.2.** Replace "with a verified `@<approved domain>` email. That's the same domain AX's Google sign-in allows." with:
  "with a verified email on an approved domain. The approved domains are the ones AX's Google sign-in allows: the Google provider's *Allowed email domains* list. When that list is blank, sign-in accepts any domain, and so does this check."

- [ ] **Step 2: §6.** Rewrite the "Finding a user by verified email" block to:
  - name the hook as built, `auth:find-user-by-email`: `{ email } → { userId } | null` (TASK-1092)
  - say "Attended channel turns (§2) and personal-agent DMs need it" in place of "Tier-3 attended turns…"
  - add one bullet with the rules: case-insensitive and otherwise exact, verified accounts only, approved domains only (blank = any), accounts that differ only in case match nobody, and `null` never says why
  - keep the Alternate implementation and Leaky field names bullets
  - extend Risk with "an ipc-core test pins that no runner action reaches an `auth:` hook. Callers pass only an email they fetched from the identity provider themselves"
  - add **Open for TASK-1094:** "It says nothing about company members who have no AX account, and channel-slack can't read the approved domains. Admitting them as external (§2) needs that answer from auth. Add it with that card. Don't copy the domain list into channel-slack."
  - change "**No other new hooks.**" to "**No other new hooks** (apart from the open question above)."

- [ ] **Step 3: Check the prose spellings.**
  Run: `grep -n "approved domain\|same domain\|Tier-3" docs/plans/2026-11-09-channel-slack-design.md`
  Expected: no `same domain`, no `Tier-3`. Each remaining `approved domain` hit matches the list meaning.

- [ ] **Step 4: Commit**
```bash
git add docs/plans/2026-11-09-channel-slack-design.md
git commit -m "docs(plans): channel-slack design names auth:find-user-by-email and the approved-domain list (TASK-1092)"
```
