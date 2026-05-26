# Retire `@ax/auth-oidc` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `@ax/auth-oidc` from the workspace. Boundary types move into `@ax/auth-better`; six consumer-test fixtures swap to `signInAsAdmin` from `@ax/test-harness`; every dangling workspace dep and stale comment is cleaned up.

**Architecture:** Phased so partial states still pass `pnpm build`. Phase 1 moves types into `auth-better` and decouples auth-better from auth-oidc. Phase 2 migrates each of the six consumer tests one at a time. Phase 3 drops the workspace deps + tsconfig refs across consumers. Phase 4 verifies the rate-limit posture and deletes the package.

**Tech Stack:** pnpm workspaces, TypeScript project references, vitest, postgres testcontainers, kysely, better-auth.

**Invariants (carried from `2026-05-20-auth-oidc-retirement-design.md`):**
- **I1** No `@ax/auth-oidc` imports survive.
- **I2** Boundary-contract comments survive the move.
- **I3** No production behavior change.
- **I4** `signInAsAdmin` round-trips against real http-server.
- **I5** Second-user SQL inserts match auth-better's schema.
- **I6** Tests that don't load `@ax/credentials` mock the envelope hooks.
- **I7** `dev-bootstrap.ts` + rate-limit middleware vanish with the package.
- **I8** Re-exports stay backward-compatible (single import target from `@ax/auth-better`).

---

## Phase 1 — Types move into `@ax/auth-better`

After Phase 1, `auth-better` no longer depends on `auth-oidc`. `auth-oidc` still builds; its types are unused.

### Task 1: Create `packages/auth-better/src/types.ts`

**Files:**
- Create: `packages/auth-better/src/types.ts`

**Why this file is its own module:** Boundary types belong adjacent to the impl that registers them. Keeping them in a dedicated `types.ts` (rather than inlining in `plugin.ts`) preserves the option of one day spinning them out into `@ax/auth-protocol` without touching the impl file. `auth-better/src/index.ts` re-exports them so external consumers have one import target.

- [ ] **Step 1: Create `packages/auth-better/src/types.ts` with the boundary types**

```typescript
/**
 * @ax/auth-better public hook payload types.
 *
 * BOUNDARY CONTRACT — these types are the auth alternate-impl boundary
 * (mirrors the `@ax/sandbox-k8s` / `@ax/sandbox-subprocess` pattern).
 * A future `@ax/auth-saml`, `@ax/auth-passkeys`, or any other auth plugin
 * MUST register the same hook surface with the same shapes. Consumers
 * (`@ax/agents`, the chat orchestrator, the CLI bootstrap, channel-web)
 * resolve users only through the bus — they MUST NOT duplicate the
 * `User` type or speak directly to `auth_better_v1_*` tables.
 *
 * Lock-ins keeping the swap cheap:
 *   1. `User` lives here only. Consumers reference this type, never copy
 *      it. Drift = boundary violation. If a consumer needs a subset
 *      (`{userId, isAdmin}` for an actor payload), that's fine — subsets
 *      don't break alternate impls.
 *   2. Tenant tables (`auth_better_v1_*`) are scoped to this package's
 *      `migrations.ts` + `plugin.ts`. Alternate impls own their own tables.
 *   3. IdP-callback error sanitization is part of the contract, not the
 *      impl: an alternate auth plugin MUST log only `error.code`,
 *      NEVER `error.message` (raw IdP errors carry user-controlled
 *      `state` and other request echoes).
 *
 * NOTE on `HttpRequestLike`: this plugin MUST NOT import from
 * `@ax/http-server` (Invariant I2 — no cross-plugin imports). To accept a
 * request adapter without that import, we declare the structural minimum we
 * need locally. `@ax/http-server`'s `HttpRequest` duck-types compatibly
 * because TypeScript's structural typing checks shape, not nominal type.
 * Keeping the surface minimal (cookies + headers) means a future
 * alternate-impl could provide it from a non-HTTP transport with no extra
 * coupling.
 */
export interface HttpRequestLike {
  readonly headers: Record<string, string>;
  /**
   * Returns the verified plaintext for an HMAC-signed cookie, or null if
   * absent / malformed / forged. Constant-time comparison; never throws.
   */
  signedCookie(name: string): string | null;
}

/**
 * Authenticated user as seen by every consumer (chat path, admin
 * endpoints, CLI). This is the boundary type — DO NOT redefine in
 * consumers. If a future field lands (e.g., `mfaEnrolled`), add it here
 * and let TypeScript surface every consumer that needs to handle it.
 */
export interface User {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

export interface RequireUserInput {
  req: HttpRequestLike;
}

export interface RequireUserOutput {
  user: User;
}

export interface GetUserInput {
  userId: string;
}

export type GetUserOutput = User | null;

export interface CreateBootstrapUserInput {
  displayName: string;
  email?: string;
  /**
   * Forward-compat: a future local-password slice will hash + persist this
   * via better-auth's credential account. Today it is accepted but ignored
   * by the auth-better impl (see plugin.ts `createBootstrapUser`).
   */
  password?: string;
}

export interface CreateBootstrapUserOutput {
  user: User;
  /**
   * Single-use token the bootstrap CLI exchanges for a session cookie.
   * NEVER returned via `auth:require-user` / `auth:get-user` (Invariant I9 —
   * tokens never leak through hook return values).
   */
  oneTimeToken: string;
}

export interface CompleteBootstrapUserInput {
  /**
   * The single-use token returned by `auth:create-bootstrap-user`. The
   * impl wraps this token into a cookie payload without touching
   * session state — the session was already persisted by
   * `auth:create-bootstrap-user` and stays valid until normal session
   * expiry. Single-use enforcement is the caller's responsibility: the
   * onboarding wizard's `/setup/admin` route destroys the bootstrap
   * session before/after this call so the token can't be replayed.
   */
  oneTimeToken: string;
  /** Forward-compat for the local-password slice; ignored today. */
  password?: string;
}

export interface CompleteBootstrapUserOutput {
  /**
   * Cookie payload for the wizard route to set on its response. Cookie
   * shape is HTTP-universal (not transport-specific to the impl), so
   * passing it through the bus does not violate Invariant I1. The
   * onboarding plugin sets this verbatim via `res.setSignedCookie`.
   */
  sessionCookie: {
    name: string;
    value: string;
    opts: {
      path: string;
      sameSite: 'Lax' | 'Strict' | 'None';
      secure?: boolean;
      maxAge: number;
    };
  };
}
```

- [ ] **Step 2: Run tsc on auth-better to verify the new file compiles**

Run: `pnpm --filter @ax/auth-better build`
Expected: passes. (The new file is unused at this point — types.ts compiles even though nothing imports it yet.)

- [ ] **Step 3: Commit**

```bash
git add packages/auth-better/src/types.ts
git commit -m "feat(auth-better): add boundary types as own module

Carries the boundary-contract block verbatim from auth-oidc/src/types.ts,
minus AuthConfig (auth-oidc-only). Adjacent to the impl that registers
the hook surface. Re-export wiring lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Re-export the types from `@ax/auth-better/src/index.ts`

**Files:**
- Modify: `packages/auth-better/src/index.ts`

- [ ] **Step 1: Replace the auth-oidc re-export with the local one**

Replace the entire current file (currently re-exports from `@ax/auth-oidc`) with:

```typescript
export { createAuthBetterPlugin } from './plugin.js';
export {
  runAuthBetterMigration,
  type AuthBetterDatabase,
} from './migrations.js';
export type { AuthBetterConfig } from './plugin.js';
export type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  GetUserInput,
  GetUserOutput,
  HttpRequestLike,
  RequireUserInput,
  RequireUserOutput,
  User,
} from './types.js';
```

- [ ] **Step 2: Run tsc on auth-better**

Run: `pnpm --filter @ax/auth-better build`
Expected: fails — `plugin.ts` still type-imports from `@ax/auth-oidc` (we fix that in Task 3). The interim failure proves the index now points at the local types.

- [ ] **Step 3: Commit (with --no-verify off — let the broken state hang for one commit so the diff is reviewable)**

Don't commit yet — Task 3 lands immediately after and we'll commit them together. Skip to Task 3.

---

### Task 3: Switch `plugin.ts` to local type imports

**Files:**
- Modify: `packages/auth-better/src/plugin.ts:23-31` (the type-only import from `@ax/auth-oidc`)
- Modify: `packages/auth-better/src/plugin.ts:407-410` (the inline `HttpRequestLike` interface)
- Modify: `packages/auth-better/src/plugin.ts:235` (uses `User` from auth-oidc)

- [ ] **Step 1: Replace the auth-oidc type import at lines 22-31**

Current (lines 22-31):

```typescript
// Type-only import from `@ax/auth-oidc` — boundary types are the contract
// (a future @ax/auth-better is an alternate impl of the same hook surface).
// Same I2 escape hatch: types-only.
import type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  User,
} from '@ax/auth-oidc';
```

Replace with:

```typescript
import type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  HttpRequestLike,
  User,
} from './types.js';
```

(Note: `HttpRequestLike` joins the import — we collapse the inline interface in Step 2.)

- [ ] **Step 2: Delete the inline `HttpRequestLike` interface at lines ~400-410**

Find the block beginning with `/**\n * Structural minimum we need from an HTTP request adapter for` and delete it through the closing `}` of the `interface HttpRequestLike` declaration. The shared type now flows from `./types.js`.

- [ ] **Step 3: Run tsc on auth-better**

Run: `pnpm --filter @ax/auth-better build`
Expected: PASSES. The types resolve through `./types.js`; the inline interface is gone; no other references to `@ax/auth-oidc` remain in `plugin.ts`.

- [ ] **Step 4: Run auth-better tests**

Run: `pnpm --filter @ax/auth-better test`
Expected: tests still type-import from `@ax/auth-oidc` (Task 4 fixes them). The migration test, hot-reload test, etc. may compile OK because TypeScript still resolves `@ax/auth-oidc` from `node_modules`. Vitest may pass; tsc -b on the test config might warn. Either is fine — Task 4 cleans it up.

- [ ] **Step 5: Commit Tasks 2 + 3 together**

```bash
git add packages/auth-better/src/index.ts packages/auth-better/src/plugin.ts
git commit -m "feat(auth-better): own the boundary types

Re-export from ./types.js; drop the type-only import from @ax/auth-oidc
and the inline HttpRequestLike declaration. The hook surface contract is
now adjacent to the impl that registers it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Update auth-better's own test imports

**Files:**
- Modify: `packages/auth-better/src/__tests__/bootstrap-user.test.ts:13-19`
- Modify: `packages/auth-better/src/__tests__/reset-cleanup.test.ts:17-23` (verify line range; the block imports `User` + bootstrap I/O types from auth-oidc)

- [ ] **Step 1: In `bootstrap-user.test.ts`, swap the import source**

Find:

```typescript
import type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  User,
} from '@ax/auth-oidc';
```

Replace with:

```typescript
import type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  User,
} from '../index.js';
```

- [ ] **Step 2: In `reset-cleanup.test.ts`, do the same swap**

Locate the equivalent `import type { ... } from '@ax/auth-oidc'` block. Replace `from '@ax/auth-oidc'` with `from '../index.js'`. Keep the imported symbol list identical (verify against the existing block — symbols may be a subset of `bootstrap-user.test.ts`).

- [ ] **Step 3: Run auth-better tests**

Run: `pnpm --filter @ax/auth-better test`
Expected: all auth-better tests pass. The harness still loads only `@ax/database-postgres` + `createAuthBetterPlugin`; nothing depends on auth-oidc at runtime here.

- [ ] **Step 4: Commit**

```bash
git add packages/auth-better/src/__tests__/bootstrap-user.test.ts packages/auth-better/src/__tests__/reset-cleanup.test.ts
git commit -m "test(auth-better): type-import from own index

Internal test files were the last @ax/auth-oidc consumers inside the
auth-better package. Drop is now clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Drop `@ax/auth-oidc` from `auth-better`'s `package.json` + `tsconfig.json`

**Files:**
- Modify: `packages/auth-better/package.json:devDependencies`
- Modify: `packages/auth-better/tsconfig.json:references`

- [ ] **Step 1: Remove `"@ax/auth-oidc": "workspace:*"` from `packages/auth-better/package.json`**

Delete this line from `devDependencies`:

```json
"@ax/auth-oidc": "workspace:*",
```

- [ ] **Step 2: Remove the tsconfig reference**

In `packages/auth-better/tsconfig.json`, change:

```json
"references": [{ "path": "../core" }, { "path": "../auth-oidc" }]
```

to:

```json
"references": [{ "path": "../core" }]
```

- [ ] **Step 3: Reconcile the lockfile**

Run: `pnpm install`
Expected: lockfile updates to remove the auth-better → auth-oidc workspace edge.

- [ ] **Step 4: Verify build + tests**

Run: `pnpm --filter @ax/auth-better build && pnpm --filter @ax/auth-better test`
Expected: both pass. auth-better has no `@ax/auth-oidc` references anywhere now.

- [ ] **Step 5: Commit**

```bash
git add packages/auth-better/package.json packages/auth-better/tsconfig.json pnpm-lock.yaml
git commit -m "chore(auth-better): drop @ax/auth-oidc workspace dep

The type-only consumption is gone; the package no longer needs auth-oidc
in any dependency graph. Phase 1 of the auth-oidc retirement complete.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Migrate consumer test fixtures

Each consumer test gets the same shape change: swap `createAuthPlugin` for `createAuthBetterPlugin`, swap the `/auth/dev-bootstrap` `fetch` for `signInAsAdmin`, and (where applicable) update second-user SQL to auth-better's schema. Tasks are ordered so a failed migration doesn't block the others.

### Task 6: Migrate `@ax/agents` test

**Files:**
- Modify: `packages/agents/src/__tests__/admin-routes.test.ts`

The current shape: boots real http-server + auth-oidc, posts to `/auth/dev-bootstrap` for User A, raw-SQL-inserts a synthetic User B, signs both cookies with `signCookieValue(COOKIE_KEY, ...)`.

- [ ] **Step 1: Swap the import**

Find at line 18:

```typescript
import { createAuthPlugin } from '@ax/auth-oidc';
```

Replace with:

```typescript
import { createAuthBetterPlugin } from '@ax/auth-better';
import { signInAsAdmin } from '@ax/test-harness';
```

- [ ] **Step 2: Drop the `DEV_TOKEN` constant**

Find and delete the `const DEV_TOKEN = '...'` declaration (around the top of the file, near `COOKIE_KEY`). The dev-bootstrap token is unused after this task.

- [ ] **Step 3: Swap the plugin construction**

Find:

```typescript
createAuthPlugin({ providers: {}, devBootstrap: { token: DEV_TOKEN } }),
```

Replace with:

```typescript
createAuthBetterPlugin(),
```

- [ ] **Step 4: Add the envelope hook stubs to the harness `services:` map**

The harness already has a `services:` map (the existing block stubs `db:transact` etc.). Add these two entries to that map (or create the `services:` map if it doesn't have one — check the existing block, agents test typically has none, so create it inline above the `plugins:` list inside the `createTestHarness({...})` call):

```typescript
services: {
  'credentials:envelope-encrypt': async (_ctx, input) => ({
    ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
  }),
  'credentials:envelope-decrypt': async (_ctx, input) => ({
    plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
  }),
},
```

These no-op pass-through stubs satisfy `auth-better`'s `verifyCalls()` gate (its manifest declares `credentials:envelope-encrypt/decrypt` in `calls`). Agents tests don't insert provider rows, so neither stub is ever invoked at runtime; the gate is the only consumer.

- [ ] **Step 5: Replace the `signIn(stack)` helper body**

Find the existing `signIn` helper (currently does `fetch('/auth/dev-bootstrap', {method:'POST', ...})` and extracts the `ax_auth_session=` cookie). Replace its body with:

```typescript
async function signIn(stack: BootedStack): Promise<string> {
  const { cookieHeader } = await signInAsAdmin({
    bus: stack.harness.bus,
    cookieKey: COOKIE_KEY,
    displayName: 'Test Admin',
    email: 'admin@example.com',
  });
  return cookieHeader;
}
```

The return shape (`string` — the `cookieHeader` value like `ax_auth_session=signed-value`) matches the existing signature so every call site stays unchanged.

- [ ] **Step 6: Update the synthetic User B SQL inserts**

Find the block that inserts into `auth_v1_users` and `auth_v1_sessions` (around line 170). Replace the two `INSERT INTO auth_v1_*` statements with auth-better's column shape:

```typescript
const userId = `usr_${randomBytes(16).toString('hex')}`;
const sessionId = `sess_${randomBytes(16).toString('hex')}`;
const token = randomBytes(32).toString('base64url');
const now = new Date();
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

await c.query(
  `INSERT INTO auth_better_v1_users (id, email, email_verified, name, image, role, created_at, updated_at)
   VALUES ($1, $2, false, $3, NULL, 'user', $4, $4)
   ON CONFLICT (email) DO NOTHING`,
  [userId, `user-b-${userId}@example.invalid`, 'User B', now],
);
await c.query(
  `INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at)
   VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)`,
  [sessionId, userId, token, expiresAt, now],
);

const { signCookieValue } = await import('@ax/http-server');
const wire = signCookieValue(COOKIE_KEY, token);
return { userId, cookie: `ax_auth_session=${wire}` };
```

Key changes vs. the auth-oidc-shape:
- Table names: `auth_v1_users` → `auth_better_v1_users`; same for sessions.
- The cookie value is now the `token` column (auth-better stores token-as-cookie-value), not the `session_id`.
- `email` is NOT NULL in auth-better; supply a unique synthetic value.
- `role` column replaces `is_admin` (use `'user'`, not `'admin'`).
- `is_admin` field is gone — auth-better derives `isAdmin` from `role === 'admin'`.

- [ ] **Step 7: Run the agents test**

Run: `pnpm --filter @ax/agents test`
Expected: all admin-routes tests pass. User A signs in via `signInAsAdmin`; User B's synthetic cookie round-trips through the http-server's `signedCookie` validator and resolves to the synthetic row.

- [ ] **Step 8: Commit**

```bash
git add packages/agents/src/__tests__/admin-routes.test.ts
git commit -m "test(agents): migrate admin-routes fixture to auth-better

Drops the /auth/dev-bootstrap fetch in favor of signInAsAdmin, swaps the
synthetic User B SQL to auth-better's schema, no-op envelope stubs satisfy
verifyCalls(). Coverage shape is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Migrate `@ax/teams` test

**Files:**
- Modify: `packages/teams/src/__tests__/admin-routes.test.ts`

Shape is identical to Task 6. Same six in-file changes.

- [ ] **Step 1: Swap the import**

Find at line 18:

```typescript
import { createAuthPlugin } from '@ax/auth-oidc';
```

Replace with:

```typescript
import { createAuthBetterPlugin } from '@ax/auth-better';
import { signInAsAdmin } from '@ax/test-harness';
```

- [ ] **Step 2: Drop the `DEV_TOKEN` constant**

Delete the `const DEV_TOKEN = '...'` declaration near the top of the file.

- [ ] **Step 3: Swap the plugin construction**

Find:

```typescript
createAuthPlugin({ providers: {}, devBootstrap: { token: DEV_TOKEN } }),
```

Replace with:

```typescript
createAuthBetterPlugin(),
```

- [ ] **Step 4: Add envelope hook stubs to the harness `services:` map**

Same block as Task 6 Step 4 — add (or create) the `services:` map entry inside `createTestHarness({...})`:

```typescript
services: {
  'credentials:envelope-encrypt': async (_ctx, input) => ({
    ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
  }),
  'credentials:envelope-decrypt': async (_ctx, input) => ({
    plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
  }),
},
```

- [ ] **Step 5: Replace the `signIn(stack)` helper body**

```typescript
async function signIn(stack: BootedStack): Promise<string> {
  const { cookieHeader } = await signInAsAdmin({
    bus: stack.harness.bus,
    cookieKey: COOKIE_KEY,
    displayName: 'Test Admin',
    email: 'admin@example.com',
  });
  return cookieHeader;
}
```

- [ ] **Step 6: Update the synthetic User B SQL inserts** (same block as Task 6 Step 6, around line 120)

```typescript
const userId = `usr_${randomBytes(16).toString('hex')}`;
const sessionId = `sess_${randomBytes(16).toString('hex')}`;
const token = randomBytes(32).toString('base64url');
const now = new Date();
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

await c.query(
  `INSERT INTO auth_better_v1_users (id, email, email_verified, name, image, role, created_at, updated_at)
   VALUES ($1, $2, false, $3, NULL, 'user', $4, $4)
   ON CONFLICT (email) DO NOTHING`,
  [userId, `user-b-${userId}@example.invalid`, 'User B', now],
);
await c.query(
  `INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at)
   VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)`,
  [sessionId, userId, token, expiresAt, now],
);

const { signCookieValue } = await import('@ax/http-server');
const wire = signCookieValue(COOKIE_KEY, token);
return { userId, cookie: `ax_auth_session=${wire}` };
```

- [ ] **Step 7: Run the teams test**

Run: `pnpm --filter @ax/teams test`
Expected: all admin-routes tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/teams/src/__tests__/admin-routes.test.ts
git commit -m "test(teams): migrate admin-routes fixture to auth-better

Same shape as the agents migration: signInAsAdmin + auth-better schema for
the synthetic User B path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Migrate `@ax/mcp-client` test

**Files:**
- Modify: `packages/mcp-client/src/__tests__/admin-routes.test.ts`

This one is bigger (the file has TWO `createAuthPlugin` call sites — the main harness and a second test that builds its own harness inline at line ~887). Both must migrate. The test already loads real `@ax/credentials`, so envelope-hook stubs are NOT needed.

- [ ] **Step 1: Swap the import**

Find at line 19:

```typescript
import { createAuthPlugin } from '@ax/auth-oidc';
```

Replace with:

```typescript
import { createAuthBetterPlugin } from '@ax/auth-better';
import { signInAsAdmin } from '@ax/test-harness';
```

- [ ] **Step 2: Drop the `DEV_TOKEN` constant**

Delete `const DEV_TOKEN = '...'`. mcp-client may have it named differently — search for `DEV_TOKEN` and verify before deleting.

- [ ] **Step 3: Swap BOTH plugin constructions**

The first is in the shared `bootHarness()` around line 220:

```typescript
createAuthPlugin({ providers: {}, devBootstrap: { token: DEV_TOKEN } }),
```

Replace with:

```typescript
createAuthBetterPlugin(),
```

The second is inside an inline harness around line 887 in a specific test (search for the second occurrence of `createAuthPlugin`). Same replacement.

- [ ] **Step 4: Replace the `signIn` helper around line 260**

```typescript
async function signIn(stack: BootedStack): Promise<string> {
  const { cookieHeader } = await signInAsAdmin({
    bus: stack.harness.bus,
    cookieKey: COOKIE_KEY,
    displayName: 'Test Admin',
    email: 'admin@example.com',
  });
  return cookieHeader;
}
```

The second test (around line 887) may have its own inline sign-in via fetch — search for `/auth/dev-bootstrap` to find both call sites. Replace inline `fetch` block with a direct `signInAsAdmin` call against that harness's bus.

- [ ] **Step 5: Update synthetic User B SQL** (search for `auth_v1_users`)

Same shape as Task 6 Step 6.

- [ ] **Step 6: NOTE — the inline credential-seeding test (around line 516)**

The existing comment at mcp-client/src/__tests__/admin-routes.test.ts:516-518 says "credential MUST be seeded under whatever userId the dev-bootstrap may resolve". With `signInAsAdmin`, the helper returns the minted user via `result.user.id` — capture it explicitly when seeding:

```typescript
const { cookieHeader, user } = await signInAsAdmin({
  bus: stack.harness.bus,
  cookieKey: COOKIE_KEY,
});
const adminId = (user as { id: string }).id;
// ...use adminId when seeding credentials
```

Update the comment too — the resolution mechanism is now the bus call, not dev-bootstrap.

- [ ] **Step 7: Run the mcp-client test**

Run: `pnpm --filter @ax/mcp-client test`
Expected: all admin-routes tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-client/src/__tests__/admin-routes.test.ts
git commit -m "test(mcp-client): migrate admin-routes fixture to auth-better

Both harness call sites swap to createAuthBetterPlugin + signInAsAdmin.
The credential-seeding test captures the minted admin id from the helper
return so credential rows attach to the right owner. Envelope hooks come
from the real @ax/credentials plugin that the test already loads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Migrate `@ax/onboarding`'s `admin-route.test.ts`

**Files:**
- Modify: `packages/onboarding/src/__tests__/admin-route.test.ts`

This test does NOT load `@ax/credentials` and does NOT sign in (its tests exercise the `/setup/admin` bootstrap-token gate, not the post-bootstrap cookie). Migration is minimal: import swap + plugin swap + envelope stubs.

- [ ] **Step 1: Swap the import**

Find at line 19:

```typescript
import { createAuthPlugin } from '@ax/auth-oidc';
```

Replace with:

```typescript
import { createAuthBetterPlugin } from '@ax/auth-better';
```

(No `signInAsAdmin` here — the test doesn't sign in.)

- [ ] **Step 2: Swap the plugin construction at lines 101-104**

Find:

```typescript
createAuthPlugin({
  providers: {},
  devBootstrap: { token: 'auth-oidc-dev-bootstrap-token' },
}),
```

Replace with:

```typescript
createAuthBetterPlugin(),
```

- [ ] **Step 3: Add envelope stubs to the existing `services:` map**

The harness at line 92 already has a `services:` map (stubs `db:transact`, `credentials:set`, etc.). Add two more entries:

```typescript
'credentials:envelope-encrypt': async (_ctx, input) => ({
  ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
}),
'credentials:envelope-decrypt': async (_ctx, input) => ({
  plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
}),
```

- [ ] **Step 4: Run the onboarding admin-route tests**

Run: `pnpm --filter @ax/onboarding test admin-route`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/onboarding/src/__tests__/admin-route.test.ts
git commit -m "test(onboarding): migrate admin-route fixture to auth-better

Plugin swap + envelope stubs added to the existing services map. No
signIn change needed — this test gates on the bootstrap token, not the
post-bootstrap cookie.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Migrate `@ax/onboarding`'s `model-route.test.ts`

**Files:**
- Modify: `packages/onboarding/src/__tests__/model-route.test.ts`

This test loads real `@ax/credentials` (it exercises the `/setup/model` credential write path). Migration: import swap + plugin swap. No envelope stubs needed.

- [ ] **Step 1: Swap the import at line 35**

```typescript
import { createAuthPlugin } from '@ax/auth-oidc';
```

Replace with:

```typescript
import { createAuthBetterPlugin } from '@ax/auth-better';
```

- [ ] **Step 2: Swap the plugin construction at line 94**

Find the `createAuthPlugin({...})` call. Replace with:

```typescript
createAuthBetterPlugin(),
```

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @ax/onboarding test model-route`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/onboarding/src/__tests__/model-route.test.ts
git commit -m "test(onboarding): migrate model-route fixture to auth-better

Loads real @ax/credentials so envelope hooks resolve naturally. Plugin
swap is the only change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Migrate `@ax/onboarding`'s `e2e-happy.test.ts`

**Files:**
- Modify: `packages/onboarding/src/__tests__/e2e-happy.test.ts`

This is the end-to-end test (claim → admin → model → done). Loads real `@ax/credentials`. Migration is similar to Task 10 but the auth-oidc plugin block is at line 135 and may have provider/dev-bootstrap config that needs to be dropped.

- [ ] **Step 1: Swap the import at line 43**

```typescript
import { createAuthPlugin } from '@ax/auth-oidc';
```

Replace with:

```typescript
import { createAuthBetterPlugin } from '@ax/auth-better';
```

- [ ] **Step 2: Read the existing plugin construction block at line 135**

Run: `sed -n '125,150p' packages/onboarding/src/__tests__/e2e-happy.test.ts`

If the call is `createAuthPlugin({ devBootstrap: {...}, providers: {...} })`, the replacement is `createAuthBetterPlugin()`. If there's any `trustedOrigins`-equivalent setting being passed, fold it through (auth-better accepts `{trustedOrigins: string[]}`); a quick way to verify: `grep -n trustedOrigins packages/onboarding/src/__tests__/e2e-happy.test.ts`. The expected outcome is the same shape as Task 10 — `createAuthBetterPlugin()` with no args.

- [ ] **Step 3: Swap the plugin construction**

```typescript
createAuthBetterPlugin(),
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @ax/onboarding test e2e-happy`
Expected: pass — the e2e claims bootstrap, creates the admin via `auth:create-bootstrap-user` (now auth-better's impl), then completes the model step.

- [ ] **Step 5: Commit**

```bash
git add packages/onboarding/src/__tests__/e2e-happy.test.ts
git commit -m "test(onboarding): migrate e2e-happy fixture to auth-better

End-to-end onboarding now boots auth-better instead of auth-oidc. The
bootstrap path is the same hook contract, so no test assertions change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Verify all six tests pass together

After every consumer migration, do a full cross-package run to catch interaction surprises.

- [ ] **Step 1: Run the migrated tests in one pass**

Run: `pnpm --filter @ax/agents --filter @ax/teams --filter @ax/mcp-client --filter @ax/onboarding test`
Expected: every test passes.

- [ ] **Step 2: Run `grep` to confirm no `createAuthPlugin` references remain in test files**

Run: `grep -rn 'createAuthPlugin' packages/ --include='*.ts' | grep -v packages/auth-oidc`
Expected: empty output.

- [ ] **Step 3: No commit** — this task is verification only.

---

## Phase 3 — Drop workspace deps + tsconfig references

After Phase 3, no `package.json` or `tsconfig.json` outside `packages/auth-oidc/` references `@ax/auth-oidc`.

### Task 13: Drop `@ax/auth-oidc` from consumer `package.json` files

**Files:**
- Modify: `packages/agents/package.json`
- Modify: `packages/teams/package.json`
- Modify: `packages/mcp-client/package.json`
- Modify: `packages/onboarding/package.json`
- Modify: `packages/channel-web/package.json`

- [ ] **Step 1: Verify which deps section each one uses**

Run: `for p in agents teams mcp-client onboarding channel-web; do echo "=== $p ==="; grep -B1 -A1 '@ax/auth-oidc' packages/$p/package.json; done`
Expected: each shows `"@ax/auth-oidc": "workspace:*"` either in `dependencies` or `devDependencies`. Note which section in each.

- [ ] **Step 2: Delete the `@ax/auth-oidc` line from each `package.json`**

For each file, locate the `"@ax/auth-oidc": "workspace:*"` line (in `dependencies` for runtime deps, `devDependencies` for test-only) and delete it. Be careful about trailing commas — `package.json` is strict JSON.

- [ ] **Step 3: Reconcile the lockfile**

Run: `pnpm install`
Expected: lockfile loses every consumer's edge to `@ax/auth-oidc`. The only remaining workspace edge to auth-oidc is the package itself (it depends on `@ax/core`, `@ax/http-server`, etc.).

- [ ] **Step 4: Verify build still passes**

Run: `pnpm build`
Expected: every package builds. (TypeScript would catch any remaining import-from-auth-oidc surprise.)

- [ ] **Step 5: Verify lint passes**

Run: `pnpm lint`
Expected: no `no-restricted-imports` flags, no orphan-import warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/package.json packages/teams/package.json packages/mcp-client/package.json packages/onboarding/package.json packages/channel-web/package.json pnpm-lock.yaml
git commit -m "chore: drop @ax/auth-oidc workspace deps from consumers

Five consumer packages had a workspace edge to auth-oidc that's no longer
load-bearing. channel-web's edge was dangling (no source imports);
agents/teams/mcp-client/onboarding's edge fell out with the test-fixture
migrations in Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Drop `@ax/auth-oidc` from consumer `tsconfig.json` references

**Files:**
- Modify: `packages/channel-web/tsconfig.json` (only consumer with an explicit `references` to auth-oidc per the audit)

- [ ] **Step 1: Find the references entry**

Run: `grep -n auth-oidc packages/channel-web/tsconfig.json`
Expected: one line in the `references` array pointing at `../auth-oidc`.

- [ ] **Step 2: Delete the `{ "path": "../auth-oidc" }` reference entry**

Edit `packages/channel-web/tsconfig.json` and remove the `{ "path": "../auth-oidc" }` entry from the `references` array. Mind the JSON trailing comma.

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @ax/channel-web build`
Expected: pass. (channel-web has no source imports from auth-oidc, so the reference was dead weight.)

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/tsconfig.json
git commit -m "chore(channel-web): drop @ax/auth-oidc tsconfig reference

Was a dead reference — channel-web has no source imports from auth-oidc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Verify rate-limit posture, clean stale comments, delete the package

### Task 15: Resolve the rate-limit posture question

**Why this task exists:** The design doc flags this as a "known risk" — `@ax/auth-oidc` ran a token-bucket subscriber on `http:request` (`auth-oidc/src/plugin.ts:155-167`, 30 tokens/minute, scoped to `/auth/*`). Deleting the package drops the subscriber. The implementer MUST verify better-auth's own rate-limiting covers the protected surfaces before merging.

- [ ] **Step 1: Inspect better-auth's rate-limit configuration**

Run: `grep -rn 'rateLimit\|rate-limit\|throttl' node_modules/better-auth/dist/index.d.ts node_modules/better-auth/README.md 2>/dev/null | head -20`
Also: open `https://www.better-auth.com/docs` (via WebFetch) and check the rate-limit section.

Expected outcome: better-auth has built-in per-request rate-limiting on auth endpoints with configurable limits. Verify the default window + limit.

- [ ] **Step 2: Determine the gap (if any)**

Compare auth-oidc's posture (30 req/min per IP across all `/auth/*`) against better-auth's defaults. Three possible outcomes:

  **(a) better-auth's defaults match or exceed auth-oidc.** No code change needed — document the equivalence in the PR description (cite better-auth's docs).

  **(b) better-auth has rate-limiting but weaker defaults.** Configure better-auth's `rateLimit` option in `packages/auth-better/src/handler.ts` to match auth-oidc's 30/min limit. Add a unit test.

  **(c) better-auth has no rate-limit, or its rate-limit is bypassable.** Port the http:request subscriber from `auth-oidc/src/rate-limit.ts` into `packages/auth-better/src/plugin.ts`. Add a unit test mirroring `auth-oidc/src/__tests__/rate-limit.test.ts`.

- [ ] **Step 3: Implement the chosen mitigation (if any)**

If (a): no implementation; proceed to Step 4. If (b): add `rateLimit` config to the `betterAuth({...})` call at `handler.ts:106`, plus a test. If (c): port `rate-limit.ts` + its test into `auth-better/`.

- [ ] **Step 4: Run the full auth-better test suite**

Run: `pnpm --filter @ax/auth-better test`
Expected: pass. If new tests were added, they pass too.

- [ ] **Step 5: Commit (if any implementation was needed)**

```bash
git add packages/auth-better/
git commit -m "feat(auth-better): preserve /auth/* rate-limit posture

[Describe whichever of (a)/(b)/(c) was implemented. If (a), this commit
is empty — skip the commit and document in the PR description instead.]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Clean stale comments

**Files:**
- Modify: `packages/channel-web/src/lib/auth.ts:3`
- Modify: `packages/channel-web/src/components/LoginPage.tsx:6`
- Modify: `packages/channel-web/src/wire/chat.ts:45`
- Modify: `packages/channel-web/src/__tests__/golden-path.test.tsx:31`
- Modify: `packages/channel-web/src/__tests__/sidebar-collapse.test.tsx:58`
- Modify: `packages/channel-web/src/__tests__/server/sse.test.ts:116`
- Modify: `packages/channel-web/src/__tests__/server/acceptance-e2e.test.ts:69`
- Modify: `packages/cli/src/commands/admin.ts:15`
- Modify: `packages/cli/src/__tests__/admin-reset-bootstrap.test.ts:95`

Each of these references `@ax/auth-oidc` in comments that are now stale.

- [ ] **Step 1: Read each line and decide rephrase vs. delete**

For each file:
- **`channel-web/src/lib/auth.ts:3`** — change `"@ax/auth-better since Phase 3; @ax/auth-oidc is the alternate impl"` to `"@ax/auth-better is the only auth impl"`.
- **`channel-web/src/components/LoginPage.tsx:6`** — change `"handled by @ax/auth-oidc"` to `"handled by @ax/auth-better"`.
- **`channel-web/src/wire/chat.ts:45`** — drop the parenthetical "(@ax/auth-oidc)" mention; the surrounding sentence stays intact.
- **`channel-web/src/__tests__/golden-path.test.tsx:31`** — change `"BackendUser shape (from @ax/auth-oidc)"` to `"BackendUser shape (from @ax/auth-better)"`.
- **`channel-web/src/__tests__/sidebar-collapse.test.tsx:58`** — same fix as golden-path.
- **`channel-web/src/__tests__/server/sse.test.ts:116`** — change `"in @ax/auth-oidc"` to `"in @ax/auth-better"`.
- **`channel-web/src/__tests__/server/acceptance-e2e.test.ts:69`** — change `"in @ax/auth-oidc"` to `"in @ax/auth-better"`.
- **`cli/src/commands/admin.ts:15`** — delete the sentence `"@ax/auth-oidc remains in-tree as a fallback ..."` entirely (it's no longer in-tree).
- **`cli/src/__tests__/admin-reset-bootstrap.test.ts:95`** — change `"auth-oidc + http-server + ..."` to `"auth-better + http-server + ..."`.

- [ ] **Step 2: Run the typechecker to confirm nothing else cares**

Run: `pnpm build`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-web/src/lib/auth.ts packages/channel-web/src/components/LoginPage.tsx packages/channel-web/src/wire/chat.ts packages/channel-web/src/__tests__/golden-path.test.tsx packages/channel-web/src/__tests__/sidebar-collapse.test.tsx packages/channel-web/src/__tests__/server/sse.test.ts packages/channel-web/src/__tests__/server/acceptance-e2e.test.ts packages/cli/src/commands/admin.ts packages/cli/src/__tests__/admin-reset-bootstrap.test.ts
git commit -m "chore: drop stale @ax/auth-oidc references from comments

Nine files carried comments framing auth-oidc as primary or as a
fallback impl. None of those framings are accurate now that auth-better
owns the surface end-to-end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Delete the `packages/auth-oidc/` directory + root tsconfig reference

**Files:**
- Delete: `packages/auth-oidc/` (entire directory)
- Modify: `tsconfig.json` (root) — remove the `{ "path": "packages/auth-oidc" }` entry

- [ ] **Step 1: Sanity-check: nothing imports from `@ax/auth-oidc` anywhere**

Run: `grep -rn '@ax/auth-oidc' packages/ presets/ deploy/ .claude/skills/ 2>/dev/null | grep -v packages/auth-oidc`
Expected: empty output. (If anything matches, fix it before continuing — do not proceed to deletion with live consumers.)

- [ ] **Step 2: Remove the root tsconfig reference**

Edit `tsconfig.json` at the repo root. Find the references array entry `{ "path": "packages/auth-oidc" }` and delete it.

- [ ] **Step 3: Delete the package directory**

Run: `rm -rf packages/auth-oidc`
Expected: no errors. The directory is gone.

- [ ] **Step 4: Reconcile the lockfile**

Run: `pnpm install`
Expected: lockfile drops the `@ax/auth-oidc` package entry; no other diffs.

- [ ] **Step 5: Run the full build**

Run: `pnpm build`
Expected: every workspace builds without auth-oidc. If anything fails, the prior step's grep missed a reference — find and fix.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: every test passes. The k8s preset's acceptance test (the canary) doubles as regression coverage that nothing implicitly depended on auth-oidc.

- [ ] **Step 7: Run lint**

Run: `pnpm lint`
Expected: pass.

- [ ] **Step 8: Final grep sweep**

Run: `grep -rn 'auth-oidc' packages/ presets/ deploy/ .claude/skills/ docs/plans/2026-05-20-auth-oidc-retirement-impl.md 2>/dev/null`
Expected: only this plan file mentions `auth-oidc`. Nothing else.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: delete @ax/auth-oidc package

The retirement closes here. @ax/auth-better owns the four-hook auth
contract end-to-end. Six consumer test fixtures migrated to
signInAsAdmin (Phase 2); five package.json + one tsconfig dep edge
dropped (Phase 3); stale comments updated; rate-limit posture verified
(see Task 15 outcome in the PR description).

Closes the 'Retire @ax/auth-oidc' TODO entry. Subsumes the 'Delete
/auth/dev-bootstrap route' TODO entry — the route had no production
caller and vanishes with the package.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final acceptance checklist

After Task 17, before opening the PR:

- [ ] `pnpm build` passes from a clean state (`rm -rf packages/*/dist && pnpm build`).
- [ ] `pnpm test` passes (every package).
- [ ] `pnpm lint` passes.
- [ ] `grep -rn 'auth-oidc' packages/ presets/ deploy/ .claude/skills/` returns no hits.
- [ ] `grep -rn 'createAuthPlugin' packages/` returns no hits.
- [ ] The k8s preset's acceptance test (`presets/k8s/src/__tests__/acceptance.test.ts`) passes — the canary that boots the full plugin set and verifies nothing implicitly depended on auth-oidc.
- [ ] TODO.md updated: strike the "Retire `@ax/auth-oidc` entirely" and "Delete `/auth/dev-bootstrap` route" entries with a reference to the merged PR number.
- [ ] PR description documents the Task 15 outcome (rate-limit posture: (a), (b), or (c)).

---

## Self-review notes

**Spec coverage:** Every invariant I1–I8 in the design has a task that protects it.
- I1 (no `@ax/auth-oidc` imports) → Task 17 Step 1 + Step 8 grep sweeps.
- I2 (boundary comments survive) → Task 1 Step 1 (verbatim block carry).
- I3 (no production behavior change) → Task 17 Step 6 + acceptance checklist canary.
- I4 (`signInAsAdmin` round-trips) → Tasks 6–11 Step 7 each runs the existing test assertions.
- I5 (User B SQL matches schema) → Tasks 6–8 Step 6 supplies the exact INSERT statements.
- I6 (envelope mocks for tests not loading credentials) → Tasks 6, 7, 9 add the stubs; Tasks 8, 10, 11 explicitly note credentials is loaded already.
- I7 (dev-bootstrap + rate-limit vanish) → Task 17 Step 3 deletes the directory; Task 15 resolves the rate-limit consequence.
- I8 (single import target) → Task 2 wires `auth-better/index.ts` to re-export everything.

**Placeholder scan:** None — every step has runnable code or an exact command.

**Type consistency:** `signIn(stack: BootedStack): Promise<string>` signature is identical across Tasks 6, 7, 8. SQL column lists for `auth_better_v1_users` / `auth_better_v1_sessions` are identical across Tasks 6, 7, 8.

**Open question deferred to execution:** Task 11 Step 2 may discover that `e2e-happy.test.ts` has a non-empty config block on `createAuthPlugin` (provider config beyond what the simpler tests carry). The plan tells the implementer to inspect first and adapt — that's appropriate for a 1-of-6 outlier rather than rewriting the plan for every possibility.
