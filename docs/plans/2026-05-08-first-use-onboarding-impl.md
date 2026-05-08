# First-use onboarding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working first-use experience: operator runs ax → opens UI → 3-input wizard (token / admin password / Anthropic API key) → lands in chat with a working Default Agent. Plus the post-wizard surfaces the spec depends on (`/admin/auth` UI, user-menu Admin entry, credentials cleanup, CLI recovery tools).

**Architecture:** Adds two new plugins: `@ax/onboarding` (wizard backend + SPA + bootstrap-token lifecycle) and `@ax/auth-better` (alternate-impl of the existing `auth-oidc` hook surface, wrapping better-auth with dynamic provider config). Reuses `@ax/credentials*`, `@ax/agents`, `@ax/http-server`. Keeps `@ax/auth-oidc` in the tree as a fallback alternate-impl. Phased into 5 PRs that each ship working software.

**Tech Stack:** TypeScript, pnpm monorepo, Node 22+, Kysely + sqlite/pg, better-auth ≥ 1.x, vitest + testcontainers-postgresql, Tailwind + shadcn/ui (channel-web), better-auth's React helpers for sign-in pages. Spec: `docs/plans/2026-05-08-first-use-onboarding-design.md` (commit `248cc7a`).

---

## Source of truth

- **Spec:** `docs/plans/2026-05-08-first-use-onboarding-design.md` (referenced as §1..§5).
- **Project conventions:** `CLAUDE.md` — five invariants, half-wired-window policy, bug-fix policy.
- **Boundary contract for auth:** `packages/auth-oidc/src/types.ts:1-113` — the existing `User` boundary type and the explicit "future `@ax/auth-better-auth` alternate impl" comment.
- **Memory:** `feedback_no_oauth_credentials.md` (provider creds are API-key-only), `feedback_half_wired_window_pattern.md` (every new-plugin phase must wire to CLI + k8s preset same PR).

## Invariants (audit trail per project pattern)

These get checked off in PR notes for each phase. Numbered for cross-reference in review.

- **I1 — Hook surface stays transport- and storage-agnostic.** New hooks (`bootstrap:*`, `models:list-supported`) carry no SQL, no kysely shapes, no docker / k8s vocabulary in payload field names. Verified by running the boundary review checklist (CLAUDE.md §"Boundary review") against each new hook signature.
- **I2 — No cross-plugin imports.** `@ax/onboarding` does NOT import from `@ax/auth-oidc` / `@ax/auth-better` / `@ax/credentials*` / `@ax/agents`. All cross-plugin coordination goes through the bus.
- **I3 — No half-wired plugins.** Each phase loads its new plugin in BOTH the CLI preset (`packages/cli/src/main.ts`) and the k8s preset (whichever package owns it) in the same PR. Phase PR notes have an explicit "half-wired window: CLOSED" or "OPEN until Phase X" line.
- **I4 — One source of truth per concept.** `bootstrap_state` is owned by `@ax/onboarding`. `auth_v1_*` is owned by `@ax/auth-oidc`. `auth_better_v1_*` is owned by `@ax/auth-better`. `auth_providers` is owned by `@ax/auth-better`. No cross-plugin reach.
- **I5 — Capabilities explicit and minimized.** Each new plugin's manifest declares the smallest hook set + filesystem path + env var set it needs. Token files are mode 0600. No process spawn from `@ax/onboarding`. Untrusted content (the bootstrap token, the API key, the admin password) is treated as untrusted at every hop — hashed, encrypted, or constant-time compared.
- **I6 — Bootstrap is one-shot AND irreversible.** `bootstrap_state.status` only transitions `pending → claimed → completed`. Never backwards. Concurrent claim attempts: one wins via atomic CAS, others get 410. Tested.
- **I7 — Token validation is constant-time.** Hash comparison uses `crypto.timingSafeEqual`. A "known vulnerable" string-equals fixture is included to prove we don't regress.
- **I8 — Credential validation is synchronous and bounded.** Wizard step 2's API-key probe has a hard 10s timeout. On timeout: `{ ok: false, reason: 'credential-validation-timeout' }`, no DB writes.
- **I9 — Wizard is database-transactional.** The credential row + Default Agent row + `bootstrap:complete` happen in ONE transaction. Test: simulate agent-insert failure mid-tx → assert NO orphaned credential row.
- **I10 — Better-auth provider config hot-reloads without restart.** `auth:providers-changed` event triggers re-instantiation; the HTTP route reads the current handler instance per request. Test: add Google provider via `/admin/auth/providers`, assert `/auth/google/start` responds 302 to Google's authorize URL with no kernel restart.
- **I11 — `/setup/*` returns 410 Gone after `bootstrap:complete`.** Not 404. Operators need to know the wizard is done, not missing.
- **I12 — Provider credentials are API-key-only across the entire UI.** No "Sign in with Claude" button, no OAuth web-paste path reachable from the wizard or `/admin/credentials`. The `credentials-anthropic-oauth` and `credentials-oauth-pending` plugins are unloaded from default presets in Phase 4.

---

## File structure

### New packages

```
packages/auth-better/                        Phase 1
  package.json
  tsconfig.json
  src/
    index.ts                — public re-exports (createAuthBetterPlugin, types)
    plugin.ts               — Plugin factory, registers hook surface mirroring auth-oidc
    types.ts                — Re-imports User/AuthConfig from auth-oidc shape (boundary contract)
    handler.ts              — Wraps better-auth instance; re-instantiates on providers-changed
    migrations.ts           — auth_better_v1_users, auth_better_v1_sessions, auth_providers
    providers-store.ts      — Kysely queries for auth_providers (read/write/encrypt)
    routes.ts               — /auth/* HTTP routes (better-auth handler + /admin/auth/providers/*)
    __tests__/
      handler.test.ts
      providers-store.test.ts
      hot-reload.test.ts    — covers I10
      bootstrap-user.test.ts — covers auth:create-bootstrap-user contract

packages/onboarding/                          Phase 2
  package.json
  tsconfig.json
  src/
    index.ts                — public re-exports (createOnboardingPlugin)
    plugin.ts               — Plugin factory; bootstrap:initialize startup hook
    types.ts                — bootstrap status enum, claim payload, etc.
    migrations.ts           — bootstrap_state table
    store.ts                — Kysely queries for bootstrap_state (atomic CAS)
    token.ts                — generateToken(), printTokenToStdout(), writeTokenFile()
    routes.ts               — POST /setup/claim, /setup/admin, /setup/model, GET /setup
    rate-limit.ts           — port the pattern from auth-oidc/src/rate-limit.ts (do NOT import)
    completion-tx.ts        — orchestrates the credential + agent + bootstrap:complete tx
    spa/
      index.html            — wizard SPA entry
      wizard.tsx            — 4-screen flow (gate / admin / model / done)
      step-gate.tsx
      step-admin.tsx
      step-model.tsx
      step-done.tsx
      api-client.ts
      vite.config.ts        — builds to dist-spa/
    __tests__/
      token.test.ts         — covers I7 (constant-time)
      store.test.ts         — covers I6 (atomic CAS, status transitions)
      claim-route.test.ts
      admin-route.test.ts
      model-route.test.ts   — covers I8 (timeout) + I9 (transaction rollback)
      e2e-happy.test.ts     — full wizard happy path (vitest + testcontainer pg)
      e2e-failures.test.ts  — bad key, replay, post-completion 410, etc.
```

### Modified packages

```
packages/cli/src/main.ts                      Phases 2, 3, 4
  - Add: createOnboardingPlugin import + plugins.push (Phase 2)
  - Add: createAuthBetterPlugin import; replace createAuthPlugin (auth-oidc) (Phase 3)
  - Remove: createCredentialsAnthropicOauthPlugin from default plugin set (Phase 4)

packages/cli/src/commands/admin/              Phase 5
  - Add: reset-bootstrap.ts
  - Add: reset-password.ts
packages/cli/src/commands/admin.ts            Phase 5
  - Add: reset-bootstrap, reset-password subcommands

packages/channel-web/src/components/UserMenu.tsx     Phase 3
  - Add: "Admin" link visible only to user.isAdmin === true

packages/channel-web/src/components/credentials/CredentialAddMenu.tsx   Phase 4
  - Remove: "Sign in with Claude" option entirely
packages/channel-web/src/components/credentials/OAuthFlowForm.tsx       Phase 4
  - Delete file (component no longer imported)

packages/channel-web/src/components/admin/AdminPane.tsx     Phase 3
  - Add: AuthProvidersTab (new component)
packages/channel-web/src/components/admin/                  Phase 3
  - Create: AuthProvidersTab.tsx (list/add/toggle/delete providers)
  - Create: AddProviderForm.tsx

packages/llm-anthropic/src/plugin.ts          Phase 2
  - Register: models:list-supported service hook returning the supported model list

deploy/MANUAL-ACCEPTANCE.md                   Phase 5
  - Add: First-use wizard walkthrough
  - Add: Recovery walkthroughs (reset-bootstrap, reset-password)

deploy/charts/ax/values.yaml                  Phases 2, 3, 4
  - Phase 2: AX_BOOTSTRAP_TOKEN env (optional override)
  - Phase 3: better-auth migration; deprecate AUTH_GOOGLE_CLIENT_* env vars
  - Phase 4: drop credentials-anthropic-oauth from chart

.gitignore (already done in spec PR)
  - .superpowers/ (committed in spec PR 248cc7a)
```

### Files NOT touched (deliberate)

- `packages/auth-oidc/` — stays in tree as the fallback alternate-impl. Not loaded by default presets after Phase 3, but the package itself is intact for environments that want OIDC-without-better-auth.
- `packages/credentials-anthropic-oauth/`, `packages/credentials-oauth-pending/` — stay in tree, unloaded from default presets in Phase 4. Deletion is a separate cleanup PR (out of scope for this plan).

---

## Phase 1 — `@ax/auth-better` plugin

**Goal:** New alternate-impl of the auth hook surface, wrapping better-auth with a dynamic-provider-config plumbing layer. Built but NOT loaded by any preset yet — the existing `@ax/auth-oidc` continues serving requests until Phase 3.

**Half-wired-window status:** OPEN. The plugin exists, has tests, but no preset loads it. Closed in Phase 3.

**Acceptance for this phase:** A test harness that loads `@ax/auth-better` against a testcontainer-postgres can: (a) sign up a user with email+password, (b) sign that user in and out, (c) call `auth:create-bootstrap-user` and get a working `oneTimeToken`, (d) add a Google provider via `/admin/auth/providers`, (e) hit `/auth/google/start` and get a 302 to Google's authorize URL — all without a kernel restart.

### Task 1.1 — Scaffold the package

**Files:**
- Create: `packages/auth-better/package.json`
- Create: `packages/auth-better/tsconfig.json`
- Create: `packages/auth-better/src/index.ts`

- [ ] **Step 1: Copy `package.json` shape from `@ax/auth-oidc`**

Read `packages/auth-oidc/package.json` first. Mirror it for `@ax/auth-better`, dropping the `openid-client` dep and adding `better-auth` (latest 1.x). Keep `@ax/core`, `kysely`, `jose`. Same dev deps.

```json
{
  "name": "@ax/auth-better",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "better-auth": "^1.0.0",
    "jose": "5.10.0",
    "kysely": "0.28.16"
  },
  "devDependencies": {
    "@ax/database-postgres": "workspace:*",
    "@ax/http-server": "workspace:*",
    "@ax/test-harness": "workspace:*",
    "@testcontainers/postgresql": "11.14.0",
    "@types/node": "^25.6.0",
    "@types/pg": "8.20.0",
    "pg": "8.20.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Copy `tsconfig.json` shape verbatim from auth-oidc, swap the references list**

The `references` array should point at `@ax/core`. Read `packages/auth-oidc/tsconfig.json` to get the exact shape.

- [ ] **Step 3: Create the public re-export barrel**

```ts
// packages/auth-better/src/index.ts
export { createAuthBetterPlugin } from './plugin.js';
export {
  runAuthBetterMigration,
  type AuthBetterDatabase,
} from './migrations.js';
export type { AuthBetterConfig } from './plugin.js';
// Re-use the boundary types from auth-oidc — they ARE the contract.
// (Allowed exception: types only, no runtime import.)
export type {
  User,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
} from '@ax/auth-oidc';
```

> ⚠️ **Boundary note on the type re-export:** `auth-oidc`'s `User` type IS the alternate-impl contract (see `packages/auth-oidc/src/types.ts:1-34`). Re-exporting it as types-only doesn't violate Invariant I2 (no cross-plugin imports) because TypeScript erases types at compile time — there's no runtime dependency. Lint allowlist may need an exception.

- [ ] **Step 4: Add the package to the root pnpm workspace**

Run from repo root:
```bash
pnpm install
pnpm --filter @ax/auth-better build
```
Expected: clean build with empty source files (just the `index.ts` re-exports won't resolve yet — that's fine until Task 1.2 lands `plugin.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/auth-better/
git commit -m "feat(auth-better): scaffold package"
```

---

### Task 1.2 — Migrations: users + sessions + auth_providers

**Files:**
- Create: `packages/auth-better/src/migrations.ts`
- Create: `packages/auth-better/src/__tests__/migrations.test.ts`

Better-auth has its own internal table shape; we adapt to it. The `auth_providers` table is OUR addition for dynamic config and is independent of better-auth's internals.

- [ ] **Step 1: Write the failing migration test**

```ts
// packages/auth-better/src/__tests__/migrations.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { runAuthBetterMigration, type AuthBetterDatabase } from '../migrations.js';

describe('auth-better migrations', () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<AuthBetterDatabase>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    db = new Kysely<AuthBetterDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: container.getConnectionUri() }),
      }),
    });
    await runAuthBetterMigration(db);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it('creates auth_better_v1_users with the better-auth required columns', async () => {
    const cols = await db.introspection.getTables();
    const users = cols.find(t => t.name === 'auth_better_v1_users');
    expect(users).toBeDefined();
    expect(users!.columns.map(c => c.name).sort()).toEqual(
      ['created_at', 'email', 'email_verified', 'id', 'image', 'name', 'role', 'updated_at'].sort(),
    );
  });

  it('creates auth_better_v1_sessions', async () => {
    const cols = await db.introspection.getTables();
    expect(cols.some(t => t.name === 'auth_better_v1_sessions')).toBe(true);
  });

  it('creates auth_providers with encrypted_secret column', async () => {
    const cols = await db.introspection.getTables();
    const providers = cols.find(t => t.name === 'auth_providers');
    expect(providers).toBeDefined();
    const colNames = providers!.columns.map(c => c.name);
    expect(colNames).toContain('kind');
    expect(colNames).toContain('client_id');
    expect(colNames).toContain('client_secret_encrypted');
    expect(colNames).toContain('enabled');
  });

  it('migrations are idempotent', async () => {
    await runAuthBetterMigration(db);
    await runAuthBetterMigration(db);
    // No throw = pass
  });
});
```

- [ ] **Step 2: Run the test, watch it fail with "module not found"**

```bash
pnpm --filter @ax/auth-better test
```
Expected: FAIL — `runAuthBetterMigration` not exported.

- [ ] **Step 3: Write the migration**

```ts
// packages/auth-better/src/migrations.ts
import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/auth-better owns tables under `auth_better_v1_`
 * and `auth_providers` (the latter unprefixed for cross-impl readability —
 * no other plugin reaches in; I4 still holds).
 *
 * `auth_better_v1_users` shape mirrors better-auth's internal expectations
 * (see better-auth.json schema). We add `role` to differentiate admin from
 * user — better-auth's `additionalFields` config carries this through.
 *
 * `auth_providers` is OUR table for runtime-configurable OAuth providers.
 * `client_secret_encrypted` is enveloped via @ax/credentials's KMS layer
 * before insert; never store plaintext.
 */
export interface AuthBetterDatabase {
  auth_better_v1_users: {
    id: string;
    email: string;
    email_verified: boolean;
    name: string | null;
    image: string | null;
    role: 'admin' | 'user';
    created_at: Date;
    updated_at: Date;
  };
  auth_better_v1_sessions: {
    id: string;
    user_id: string;
    token: string;
    expires_at: Date;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
    updated_at: Date;
  };
  auth_providers: {
    kind: string;             // 'google' | 'github' | 'oidc'
    client_id: string;
    client_secret_encrypted: Uint8Array;
    discovery_url: string | null;
    allowed_domains: string | null;  // CSV
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
  };
}

export async function runAuthBetterMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS auth_better_v1_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      name TEXT,
      image TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS auth_better_v1_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_better_v1_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS auth_providers (
      kind TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret_encrypted BYTEA NOT NULL,
      discovery_url TEXT,
      allowed_domains TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}
```

- [ ] **Step 4: Re-run test, expect PASS**

```bash
pnpm --filter @ax/auth-better test
```
Expected: 4/4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/auth-better/src/migrations.ts packages/auth-better/src/__tests__/migrations.test.ts
git commit -m "feat(auth-better): users + sessions + auth_providers tables"
```

---

### Task 1.3 — Plugin factory + better-auth handler wrapper

**Files:**
- Create: `packages/auth-better/src/handler.ts`
- Create: `packages/auth-better/src/plugin.ts`
- Create: `packages/auth-better/src/__tests__/handler.test.ts`

Better-auth gives us a `betterAuth({...})` factory that returns a request handler. We wrap it so we can re-instantiate on `auth:providers-changed` without restarting the kernel.

- [ ] **Step 1: Write the failing handler test**

```ts
// packages/auth-better/src/__tests__/handler.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBetterAuthHandler, type HandlerHandle } from '../handler.js';

describe('better-auth handler wrapper', () => {
  let handle: HandlerHandle;

  beforeEach(() => {
    handle = createBetterAuthHandler({
      database: { /* stub kysely */ } as any,
      providers: [],
    });
  });

  it('returns a current handler', () => {
    expect(handle.current()).toBeInstanceOf(Function);
  });

  it('rebuilds the handler on rebuild()', () => {
    const before = handle.current();
    handle.rebuild({ database: { /* stub */ } as any, providers: [{ kind: 'google', clientId: 'x', clientSecret: 'y' }] });
    const after = handle.current();
    expect(after).not.toBe(before);
  });

  it('rebuild does not throw on a syntactically-valid-but-bogus secret', () => {
    expect(() =>
      handle.rebuild({
        database: {} as any,
        providers: [{ kind: 'google', clientId: 'x', clientSecret: 'definitely-not-a-real-google-secret' }],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, watch it fail (module missing)**

- [ ] **Step 3: Implement the handler wrapper**

```ts
// packages/auth-better/src/handler.ts
import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from './migrations.js';

export interface ProviderRow {
  kind: 'google' | 'github' | 'oidc';
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
}

export interface HandlerInput {
  database: Kysely<AuthBetterDatabase>;
  providers: ProviderRow[];
}

export interface HandlerHandle {
  current(): (req: Request) => Promise<Response>;
  rebuild(input: HandlerInput): void;
}

export function createBetterAuthHandler(input: HandlerInput): HandlerHandle {
  let instance = build(input);
  return {
    current: () => instance,
    rebuild: (next: HandlerInput) => {
      // Build the new one BEFORE replacing — if construction throws,
      // the old instance keeps serving (covers I10).
      try {
        instance = build(next);
      } catch (err) {
        // Log and keep the old instance live.
        console.error('[auth-better] handler rebuild failed; keeping previous instance', err);
      }
    },
  };
}

function build(input: HandlerInput): (req: Request) => Promise<Response> {
  const socialProviders: Record<string, unknown> = {};
  for (const p of input.providers) {
    if (p.kind === 'google') {
      socialProviders.google = { clientId: p.clientId, clientSecret: p.clientSecret };
    } else if (p.kind === 'github') {
      socialProviders.github = { clientId: p.clientId, clientSecret: p.clientSecret };
    } else if (p.kind === 'oidc') {
      socialProviders.oidc = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        discoveryUrl: p.discoveryUrl,
      };
    }
  }

  const auth = betterAuth({
    database: input.database,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    socialProviders,
    session: { expiresIn: 7 * 24 * 60 * 60 },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user' },
      },
    },
  });

  return auth.handler;
}
```

- [ ] **Step 4: Run handler test, expect PASS**

- [ ] **Step 5: Sketch the plugin factory (full impl in next task)**

```ts
// packages/auth-better/src/plugin.ts (initial sketch)
import type { Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runAuthBetterMigration, type AuthBetterDatabase } from './migrations.js';
import { createBetterAuthHandler, type HandlerHandle } from './handler.js';

export interface AuthBetterConfig {
  sessionCookieName?: string;
}

export function createAuthBetterPlugin(config: AuthBetterConfig = {}): Plugin {
  return {
    name: '@ax/auth-better',
    manifest: {
      services: ['auth:require-user', 'auth:get-user', 'auth:create-bootstrap-user'],
      subscribers: ['auth:providers-changed'],
      calls: ['database:get-instance', 'http:register-route', 'credentials:envelope-encrypt', 'credentials:envelope-decrypt'],
    },
    init: async (ctx) => {
      // ...filled in Task 1.4
    },
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/auth-better/src/handler.ts packages/auth-better/src/plugin.ts packages/auth-better/src/__tests__/handler.test.ts
git commit -m "feat(auth-better): handler wrapper with rebuild seam"
```

---

### Task 1.4 — Plugin: register hook surface (auth:require-user, auth:get-user, auth:create-bootstrap-user)

**Files:**
- Modify: `packages/auth-better/src/plugin.ts`
- Create: `packages/auth-better/src/__tests__/bootstrap-user.test.ts`

These three hooks ARE the boundary contract. The auth-oidc tests are the reference for the expected behavior. Read `packages/auth-oidc/src/__tests__/admin-routes.test.ts` and `packages/auth-oidc/src/plugin.ts:60-364` first.

- [ ] **Step 1: Write the failing contract test**

```ts
// packages/auth-better/src/__tests__/bootstrap-user.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin } from '../plugin.js';

describe('auth:create-bootstrap-user contract', () => {
  let container: StartedPostgreSqlContainer;
  let harness: TestHarness;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    harness = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString: container.getConnectionUri() }),
        createHttpServerPlugin({ port: 0 }),
        createAuthBetterPlugin(),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await harness.shutdown();
    await container.stop();
  });

  it('creates a user with role=admin and returns a oneTimeToken', async () => {
    const { user, oneTimeToken } = await harness.callService('auth:create-bootstrap-user', {
      displayName: 'Vinay',
      email: 'vinay@example.com',
    });
    expect(user.isAdmin).toBe(true);
    expect(user.email).toBe('vinay@example.com');
    expect(oneTimeToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it('rejects a second bootstrap call once an admin exists', async () => {
    await expect(
      harness.callService('auth:create-bootstrap-user', { displayName: 'Other', email: 'b@c.de' }),
    ).rejects.toThrow(/already.*bootstrap|admin already exists/i);
  });
});
```

- [ ] **Step 2: Run test, watch it fail**

- [ ] **Step 3: Fill in `plugin.ts` to satisfy the contract**

The implementation:
1. On `init`, call `database:get-instance`, run migrations, read `auth_providers`, call `createBetterAuthHandler({...})`.
2. Subscribe to `auth:providers-changed`: re-read `auth_providers`, call `handle.rebuild({...})`.
3. Register service `auth:require-user`: extract session cookie, look up `auth_better_v1_sessions` joined to `auth_better_v1_users`, return `{ user: { id, email, displayName: name, isAdmin: role === 'admin' } }` or throw `auth:no-session`.
4. Register service `auth:get-user`: same lookup by `userId`.
5. Register service `auth:create-bootstrap-user`: check if any user with `role='admin'` exists → throw if yes. Else insert user + mint a `oneTimeToken` (32 random bytes base64url) stored in a `bootstrap_one_time_tokens` row (or similar). Return `{ user, oneTimeToken }`.
6. Register HTTP routes via `http:register-route`: mount the better-auth handler at `/auth/*`. Mount `/admin/auth/providers/*` for the dynamic-provider CRUD (Task 1.5).
7. On shutdown, unsubscribe + unregister all routes.

Read `packages/auth-oidc/src/plugin.ts:62-364` for the structural template — same pattern, swap internals.

> **YAGNI check (per `feedback_yagni_check_in_plans.md`):** Don't add password-reset, email-verification, magic-link, or 2FA in this task. Spec defers all of these. Only ship what `auth:create-bootstrap-user` + email/password sign-in/sign-out require.

- [ ] **Step 4: Run all auth-better tests, expect PASS**

```bash
pnpm --filter @ax/auth-better test
```

- [ ] **Step 5: Commit**

```bash
git add packages/auth-better/src/plugin.ts packages/auth-better/src/__tests__/bootstrap-user.test.ts
git commit -m "feat(auth-better): register auth hook surface (require/get/create-bootstrap-user)"
```

---

### Task 1.5 — Provider CRUD routes + auth:providers-changed event

**Files:**
- Create: `packages/auth-better/src/providers-store.ts`
- Modify: `packages/auth-better/src/plugin.ts` (add the routes)
- Create: `packages/auth-better/src/__tests__/hot-reload.test.ts`

This is the test that proves Invariant I10: a Google provider added at runtime is live within one HTTP request, no kernel restart.

- [ ] **Step 1: Write the failing hot-reload test**

```ts
// packages/auth-better/src/__tests__/hot-reload.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin } from '../plugin.js';

describe('I10 — provider config hot-reload (no restart)', () => {
  let container: StartedPostgreSqlContainer;
  let harness: TestHarness;
  let baseUrl: string;
  let adminCookie: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    harness = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString: container.getConnectionUri() }),
        createHttpServerPlugin({ port: 0 }),
        createAuthBetterPlugin(),
      ],
    });
    baseUrl = harness.httpBaseUrl();
    adminCookie = await harness.signInAsAdmin();
  }, 60_000);

  afterAll(async () => {
    await harness.shutdown();
    await container.stop();
  });

  it('GET /auth/google/start → 404 before provider is configured', async () => {
    const res = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  it('POST /admin/auth/providers + immediate GET /auth/google/start → 302', async () => {
    const post = await fetch(`${baseUrl}/admin/auth/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        kind: 'google',
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
      }),
    });
    expect(post.status).toBe(201);

    const start = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com/);
  });

  it('disabling a provider returns 404 again', async () => {
    await fetch(`${baseUrl}/admin/auth/providers/google`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });
});
```

> **Note:** `harness.signInAsAdmin()` is a test-harness helper to seed an admin user and return a session cookie. If it doesn't exist in `@ax/test-harness`, add it as part of this task — it's load-bearing for every Phase 1+ test that needs an authenticated admin context.

- [ ] **Step 2: Run test, watch it fail at "GET /auth/google/start" (route not registered)**

- [ ] **Step 3: Implement `providers-store.ts`**

CRUD operations against `auth_providers`. Encrypt `client_secret` via `credentials:envelope-encrypt` (existing hook from PR #51) before insert.

```ts
// packages/auth-better/src/providers-store.ts
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from './migrations.js';

export interface StoredProvider {
  kind: string;
  clientId: string;
  clientSecret: string;        // decrypted on read
  discoveryUrl: string | null;
  allowedDomains: string | null;
  enabled: boolean;
}

export interface ProvidersStore {
  list(): Promise<StoredProvider[]>;
  upsert(p: { kind: string; clientId: string; clientSecret: string; discoveryUrl?: string; allowedDomains?: string }): Promise<void>;
  setEnabled(kind: string, enabled: boolean): Promise<void>;
  delete(kind: string): Promise<void>;
}

export interface CredentialsEnvelope {
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

export function createProvidersStore(
  db: Kysely<AuthBetterDatabase>,
  envelope: CredentialsEnvelope,
): ProvidersStore {
  return {
    async list() {
      const rows = await db.selectFrom('auth_providers').selectAll().execute();
      return Promise.all(
        rows.map(async (r) => ({
          kind: r.kind,
          clientId: r.client_id,
          clientSecret: await envelope.decrypt(r.client_secret_encrypted),
          discoveryUrl: r.discovery_url,
          allowedDomains: r.allowed_domains,
          enabled: r.enabled,
        })),
      );
    },
    async upsert(p) {
      const enc = await envelope.encrypt(p.clientSecret);
      await db
        .insertInto('auth_providers')
        .values({
          kind: p.kind,
          client_id: p.clientId,
          client_secret_encrypted: enc,
          discovery_url: p.discoveryUrl ?? null,
          allowed_domains: p.allowedDomains ?? null,
          enabled: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('kind').doUpdateSet({
            client_id: p.clientId,
            client_secret_encrypted: enc,
            discovery_url: p.discoveryUrl ?? null,
            allowed_domains: p.allowedDomains ?? null,
            updated_at: new Date(),
          }),
        )
        .execute();
    },
    async setEnabled(kind, enabled) {
      await db.updateTable('auth_providers').set({ enabled, updated_at: new Date() }).where('kind', '=', kind).execute();
    },
    async delete(kind) {
      await db.deleteFrom('auth_providers').where('kind', '=', kind).execute();
    },
  };
}
```

- [ ] **Step 4: Wire `/admin/auth/providers/*` routes in `plugin.ts`**

Routes:
- `GET /admin/auth/providers` → list (admin-only).
- `POST /admin/auth/providers` → upsert (admin-only). Fires `auth:providers-changed` after success.
- `PATCH /admin/auth/providers/:kind` → setEnabled (admin-only). Fires `auth:providers-changed`.
- `DELETE /admin/auth/providers/:kind` → delete (admin-only). Fires `auth:providers-changed`.

Each admin-only route does `await ctx.callService('auth:require-user', { req })` and rejects on `user.isAdmin === false` with 403.

- [ ] **Step 5: In the providers-changed subscriber, re-read store + rebuild**

```ts
ctx.subscribe('auth:providers-changed', async () => {
  const providers = await store.list();
  const enabled = providers.filter(p => p.enabled);
  handle.rebuild({ database: db, providers: enabled });
});
```

- [ ] **Step 6: Run hot-reload test, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/auth-better/src/providers-store.ts packages/auth-better/src/plugin.ts packages/auth-better/src/__tests__/hot-reload.test.ts
git commit -m "feat(auth-better): dynamic provider config + hot-reload (closes I10)"
```

---

### Task 1.6 — `pnpm test` smoke + Phase 1 close

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```
Expected: all packages pass. `@ax/auth-better` has 4 test files (migrations, handler, bootstrap-user, hot-reload), all green.

- [ ] **Step 2: Run lint**

```bash
pnpm lint
```
Verify the type-only re-export from `@ax/auth-oidc` in `index.ts` doesn't trip `no-restricted-imports`. If it does, add an exception in `eslint.config.mjs` with a comment explaining the boundary-types-as-shared-contract pattern.

- [ ] **Step 3: PR notes prep**

Phase 1 PR description should include:
- "Half-wired window: OPEN — closed in Phase 3 when presets switch from auth-oidc to auth-better."
- Invariants checklist: I1, I2, I4, I5, I10 covered. (I3 explicitly OPEN.) (I6-I9, I11, I12 are Phase 2/4 invariants — not applicable.)
- Boundary review answers (per CLAUDE.md):
  - **Alternate impl this hook surface could have:** auth-oidc (already exists), auth-saml, auth-local. All implement same `User` shape from `@ax/auth-oidc/types.ts`.
  - **Payload field names that might leak:** none new. All field names are auth-vocabulary, not backend-vocabulary.
  - **Subscriber risk for `auth:providers-changed`:** event carries no payload — subscribers re-read state from DB. Backend-agnostic.

---

## Phase 2 — `@ax/onboarding` plugin + wizard

**Goal:** Ship the wizard end-to-end against the EXISTING `@ax/auth-oidc`. After this PR, an operator can boot ax → see token in stdout → walk the wizard → land in chat with a working Default Agent.

**Half-wired-window status:** OPEN. After this PR, an admin who finishes the wizard cannot configure Google/GitHub OAuth from the UI yet (env-only) and cannot find `/admin/auth` from the user menu. Closed in Phase 3.

**Acceptance for this phase:** Manual walk on local docker-compose: bring up ax, copy token from stdout, paste into UI, finish wizard, send a chat message, get a response.

### Task 2.1 — Scaffold `@ax/onboarding` package

**Files:**
- Create: `packages/onboarding/package.json`, `tsconfig.json`, `src/index.ts`

Mirror Task 1.1's shape. Deps: `@ax/core`, `kysely`. Dev deps include `@ax/test-harness`, `@ax/auth-oidc` (peer for tests), `@ax/credentials-store-db`, `@ax/agents`, `@testcontainers/postgresql`, `pg`, `vitest`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`.

> **Capabilities (per Invariant I5) — declared in plugin manifest:**
> - DB read/write on `bootstrap_state` only.
> - HTTP routes: `POST /setup/claim`, `POST /setup/admin`, `POST /setup/model`, `GET /setup`, `GET /setup/static/*`.
> - Filesystem: write `/var/run/ax/bootstrap-token` (mode 0600). No other paths.
> - Env: `AX_BOOTSTRAP_TOKEN` (read once at boot).
> - No process spawn. No outbound network.

- [ ] **Step 1: Mirror auth-oidc scaffold (cf. Task 1.1)**
- [ ] **Step 2: `pnpm install` + `pnpm --filter @ax/onboarding build` (clean build)**
- [ ] **Step 3: Commit**: `feat(onboarding): scaffold package`

### Task 2.2 — `bootstrap_state` migration + store with atomic CAS (covers I6)

**Files:**
- Create: `packages/onboarding/src/migrations.ts`, `src/store.ts`, `src/__tests__/store.test.ts`

- [ ] **Step 1: Failing test** — `store.test.ts`:

```ts
describe('bootstrap_state store — Invariant I6', () => {
  // ...setup elided

  it('starts as null (no row)', async () => {
    expect(await store.read()).toBeNull();
  });

  it('initializeWithHash inserts pending row', async () => {
    await store.initializeWithHash('hash-A');
    const row = await store.read();
    expect(row?.status).toBe('pending');
  });

  it('claim returns ok on first call, 410 on second', async () => {
    await store.initializeWithHash('hash-A');
    const a = await store.claim();
    expect(a.ok).toBe(true);
    const b = await store.claim();
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('already-claimed-or-completed');
  });

  it('complete sets completed_at AND blocks future claims', async () => {
    await store.initializeWithHash('hash-A');
    await store.claim();
    await store.complete();
    const row = await store.read();
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBeInstanceOf(Date);
    const c = await store.claim();
    expect(c.ok).toBe(false);
  });

  it('concurrent claims: exactly one wins', async () => {
    await store.initializeWithHash('hash-A');
    const results = await Promise.all([store.claim(), store.claim(), store.claim()]);
    expect(results.filter(r => r.ok).length).toBe(1);
  });
});
```

- [ ] **Step 2: Implement migration**

```ts
// packages/onboarding/src/migrations.ts
import { sql, type Kysely } from 'kysely';

export interface OnboardingDatabase {
  bootstrap_state: {
    id: number;                                 // always 1; PK constraint
    status: 'pending' | 'claimed' | 'completed';
    token_hash: string;
    completed_at: Date | null;
    created_at: Date;
    updated_at: Date;
  };
}

export async function runOnboardingMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS bootstrap_state (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed')),
      token_hash TEXT NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}
```

- [ ] **Step 3: Implement `store.ts` with atomic CAS**

The `claim()` method MUST use `UPDATE ... WHERE status='pending' RETURNING *`:

```ts
async claim(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await db
    .updateTable('bootstrap_state')
    .set({ status: 'claimed', updated_at: new Date() })
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirst();
  return result ? { ok: true } : { ok: false, reason: 'already-claimed-or-completed' };
}
```

- [ ] **Step 4: Run store tests, expect 5/5 PASS**
- [ ] **Step 5: Commit**: `feat(onboarding): bootstrap_state store with atomic CAS (I6)`

### Task 2.3 — Token generation, printing, and constant-time hashing (covers I7)

**Files:**
- Create: `packages/onboarding/src/token.ts`, `src/__tests__/token.test.ts`

- [ ] **Step 1: Failing test** — covers (a) format, (b) constant-time comparison, (c) stdout output, (d) file output mode 0600, (e) env-var override path.

```ts
describe('bootstrap token', () => {
  it('generateToken returns ax_bs_<43+ chars base64url>', () => {
    const t = generateToken();
    expect(t).toMatch(/^ax_bs_[A-Za-z0-9_-]{43,}$/);
  });

  it('hashToken / verifyToken roundtrip', async () => {
    const t = generateToken();
    const h = await hashToken(t);
    expect(await verifyToken(t, h)).toBe(true);
    expect(await verifyToken('ax_bs_wrong', h)).toBe(false);
  });

  it('verifyToken uses constant-time comparison (Invariant I7)', async () => {
    // Soft check: assert we don't use Buffer.compare or === on the strings.
    // Hard check is via static analysis / code review; this test catches
    // a regression where someone "simplifies" to ===.
    const src = await readFile(new URL('../token.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/\bhash === /);
  });

  it('writeTokenFile creates the file with mode 0600', async () => {
    const tmpPath = join(tmpdir(), `ax-bs-${Date.now()}`);
    try {
      await writeTokenFile(tmpPath, 'ax_bs_test');
      const stat = await fsStat(tmpPath);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fsUnlink(tmpPath).catch(() => {});
    }
  });

  it('printTokenToStdout writes the human-readable banner', () => {
    const writes: string[] = [];
    const fakeStdout = (line: string) => writes.push(line);
    printTokenToStdout('ax_bs_X', 'http://localhost:8080', fakeStdout);
    const all = writes.join('\n');
    expect(all).toContain('ax_bs_X');
    expect(all).toContain('http://localhost:8080/setup?token=ax_bs_X');
    expect(all).toContain('First-run bootstrap');
  });
});
```

- [ ] **Step 2: Implement `token.ts`**

```ts
// packages/onboarding/src/token.ts
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';

export function generateToken(): string {
  const raw = randomBytes(32).toString('base64url');
  return `ax_bs_${raw}`;
}

// argon2id would be ideal, but Node's built-in crypto doesn't include it.
// scrypt is acceptable for a 32-byte high-entropy random token; the threat
// is online brute force (rate-limited at the route) and offline brute force
// against a leaked token_hash row (32 bytes of entropy is well past brute-
// force scope). A separate scrypt cost knob isn't worth the deps ceremony.
import { scryptSync } from 'node:crypto';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const SCRYPT_SALT = Buffer.from('ax-bootstrap-token-v1', 'utf8');  // fixed; not for password reuse

export async function hashToken(token: string): Promise<string> {
  const dk = scryptSync(token, SCRYPT_SALT, SCRYPT_DKLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return dk.toString('base64url');
}

export async function verifyToken(input: string, expectedHash: string): Promise<boolean> {
  const inputHash = await hashToken(input);
  const a = Buffer.from(inputHash, 'base64url');
  const b = Buffer.from(expectedHash, 'base64url');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function writeTokenFile(path: string, token: string): Promise<void> {
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);  // belt-and-braces: defend against umask
}

export function printTokenToStdout(
  token: string,
  baseUrl: string,
  out: (line: string) => void = (s) => process.stdout.write(s + '\n'),
): void {
  out('[ax-onboarding] First-run bootstrap:');
  out(`  token: ${token}`);
  out(`  open:  ${baseUrl}/setup?token=${token}`);
}
```

- [ ] **Step 3: Run token tests, expect 5/5 PASS**
- [ ] **Step 4: Commit**: `feat(onboarding): token generation + scrypt-hash + file/stdout printing (I7)`

### Task 2.4 — `bootstrap:initialize` startup hook + AX_BOOTSTRAP_TOKEN override

**Files:**
- Modify: `packages/onboarding/src/plugin.ts`

- [ ] **Step 1: Failing test** — `__tests__/initialize.test.ts`:

```ts
describe('bootstrap:initialize', () => {
  it('first boot, no env var: generates token, prints to stdout, writes file, status=pending', async () => {
    const { harness, captured } = await bootHarness({ env: {} });
    expect(captured.stdout.join('\n')).toMatch(/ax_bs_[A-Za-z0-9_-]+/);
    expect(captured.tokenFile).toBeDefined();
    expect((await harness.callService('bootstrap:status')).status).toBe('pending');
  });

  it('first boot with AX_BOOTSTRAP_TOKEN: hashes env var, NO stdout output, status=pending', async () => {
    const { harness, captured } = await bootHarness({ env: { AX_BOOTSTRAP_TOKEN: 'my-token' } });
    expect(captured.stdout.join('\n')).not.toMatch(/ax_bs_/);
    expect((await harness.callService('bootstrap:status')).status).toBe('pending');
  });

  it('subsequent boot after completion: no-op, no token printed', async () => {
    const { harness } = await bootHarness({ env: {}, preState: 'completed' });
    // ...
  });

  it('panics on first boot if BOTH stdout AND tokenfile fail (per spec §1 failure modes)', async () => {
    await expect(
      bootHarness({ env: {}, makeStdoutFail: true, makeTokenFileFail: true }),
    ).rejects.toThrow(/cannot expose bootstrap token/i);
  });
});
```

- [ ] **Step 2: Implement `bootstrap:initialize` in `plugin.ts`**

Logic:
1. Read `bootstrap_state` row.
2. If exists with `status='completed'`: log "[ax-onboarding] bootstrap already completed; skipping" and return.
3. If `AX_BOOTSTRAP_TOKEN` env set: hash it, upsert row with `status='pending'`. **Don't print.** Done.
4. Else generate new token, hash it, upsert row. Then attempt stdout AND file write. If BOTH fail, throw `PluginError` with code `bootstrap-token-unreachable` (panics kernel — per spec §5 failure modes).

- [ ] **Step 3: Run initialize tests, expect 4/4 PASS**
- [ ] **Step 4: Commit**: `feat(onboarding): bootstrap:initialize startup hook with stdout/file/env paths`

### Task 2.5 — `POST /setup/claim` route (rate limit + atomic CAS + bootstrap-session cookie)

**Files:**
- Create: `packages/onboarding/src/routes.ts`, `src/rate-limit.ts`
- Create: `packages/onboarding/src/__tests__/claim-route.test.ts`

The rate-limiter pattern is in `packages/auth-oidc/src/rate-limit.ts:1-173` — copy the algorithm but DO NOT import (Invariant I2). Inline a fresh copy with same shape.

- [ ] **Step 1: Failing test**

```ts
describe('POST /setup/claim', () => {
  it('happy path: 200 + bootstrap-session cookie scoped to /setup/*', async () => {
    const { token } = await harness.bootWithFreshToken();
    const res = await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token }), headers: {'content-type': 'application/json'} });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^ax_bootstrap_session=/);
    expect(cookie).toMatch(/Path=\/setup/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('replay: second claim with same token → 410', async () => {
    const { token } = await harness.bootWithFreshToken();
    await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token }) });
    const res = await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token }) });
    expect(res.status).toBe(410);
  });

  it('wrong token: 401', async () => {
    await harness.bootWithFreshToken();
    const res = await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token: 'ax_bs_wrong' }) });
    expect(res.status).toBe(401);
  });

  it('rate limit: 6th wrong attempt from same IP → 429', async () => {
    // ...
  });

  it('post-completion: returns 410', async () => {
    await harness.completeBootstrap();
    const res = await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token: 'ax_bs_x' }) });
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Implement claim route**

Sketch (full impl):
```ts
async function handleClaim(ctx: AgentContext, req: HttpRequest): Promise<HttpResponse> {
  // 1. If status === 'completed', return 410.
  const row = await store.read();
  if (row?.status === 'completed') return { status: 410, body: { error: 'wizard-complete' } };

  // 2. Rate limit by client IP.
  if (!rateLimit.allow(req.clientIp)) return { status: 429 };

  // 3. Verify token (constant-time).
  const { token } = await req.json();
  if (typeof token !== 'string') return { status: 400 };
  if (!row || !(await verifyToken(token, row.token_hash))) {
    rateLimit.record(req.clientIp);
    return { status: 401, body: { error: 'invalid-token' } };
  }

  // 4. Atomic CAS.
  const claim = await store.claim();
  if (!claim.ok) return { status: 410, body: { error: 'already-claimed' } };

  // 5. Mint short-lived bootstrap-session cookie.
  const sessionId = generateSessionId();
  await sessions.set(sessionId, { ttlMs: 10 * 60_000 });
  const cookie = makeBootstrapSessionCookie(sessionId, req.isHttps);

  return { status: 200, headers: { 'set-cookie': cookie }, body: { next: '/setup/admin' } };
}
```

The bootstrap-session storage is in-memory per kernel instance (single replica is fine for the wizard — it only runs once). For multi-replica deployments, the session backs onto an existing service hook (use `session-postgres` if multi-replica is a concern; otherwise in-memory is correct YAGNI).

- [ ] **Step 3: Run claim tests, expect PASS**
- [ ] **Step 4: Commit**: `feat(onboarding): POST /setup/claim with rate-limit + CAS + scoped cookie`

### Task 2.6 — `POST /setup/admin` route (calls auth:create-bootstrap-user)

**Files:**
- Modify: `packages/onboarding/src/routes.ts`
- Create: `packages/onboarding/src/__tests__/admin-route.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe('POST /setup/admin', () => {
  it('happy path: creates admin, swaps bootstrap-session for auth session', async () => {
    const { bootstrapCookie } = await harness.claimBootstrap();
    const res = await fetch(`${baseUrl}/setup/admin`, {
      method: 'POST',
      headers: { cookie: bootstrapCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Vinay', email: 'v@x.com', password: 'longenoughpassword' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next).toBe('/setup/model');
    // Bootstrap cookie cleared
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.find(c => c.startsWith('ax_bootstrap_session=') && c.includes('Max-Age=0'))).toBeDefined();
    // Auth session cookie issued
    expect(setCookies.find(c => c.startsWith('ax_auth_session='))).toBeDefined();
  });

  it('without bootstrap cookie: 401', async () => {
    const res = await fetch(`${baseUrl}/setup/admin`, { method: 'POST', body: JSON.stringify({ name: 'X', email: 'x@y.z', password: 'xxxxxxxxxxxx' }) });
    expect(res.status).toBe(401);
  });

  it('password < 12 chars: 400', async () => {
    const { bootstrapCookie } = await harness.claimBootstrap();
    const res = await fetch(`${baseUrl}/setup/admin`, {
      method: 'POST',
      headers: { cookie: bootstrapCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', email: 'x@y.z', password: 'short' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Implement**

```ts
async function handleAdmin(ctx: AgentContext, req: HttpRequest): Promise<HttpResponse> {
  if (!verifyBootstrapSession(req)) return { status: 401 };
  const { name, email, password } = await req.json();
  if (typeof password !== 'string' || password.length < 12) return { status: 400, body: { error: 'password-too-short' } };
  if (!isValidEmail(email) || !name) return { status: 400 };

  // Step A: call auth:create-bootstrap-user (auth-oidc OR auth-better — same shape).
  const { user, oneTimeToken } = await ctx.callService('auth:create-bootstrap-user', { displayName: name, email });

  // Step B: complete the admin setup with the password.
  // For auth-better, we exchange the oneTimeToken for a session via better-auth's signUp flow.
  // For auth-oidc, the oneTimeToken IS the session (existing flow).
  // Both impls expose this through `auth:complete-bootstrap-user` (NEW HOOK; see I3).
  const { sessionCookie } = await ctx.callService('auth:complete-bootstrap-user', { oneTimeToken, password });

  // Clear bootstrap cookie, set auth cookie.
  return { status: 200, headers: { 'set-cookie': [clearBootstrapCookie(), sessionCookie] }, body: { next: '/setup/model' } };
}
```

> **Hook surface change:** This task introduces a new service hook `auth:complete-bootstrap-user` to BOTH `@ax/auth-oidc` and `@ax/auth-better`. It's necessary because the spec's wizard calls for password capture, but `auth:create-bootstrap-user` returns a one-time-token (not a password-set hook). Boundary review:
> - Alternate impl: any auth plugin can answer this. `auth-saml` would error if it doesn't support passwords.
> - Field names: `oneTimeToken` (already in surface), `password` (auth-vocabulary), `sessionCookie` (HTTP-vocabulary, neutral). No leak.

> Add this hook to `@ax/auth-oidc/src/plugin.ts` AND `@ax/auth-better/src/plugin.ts`. Both PRs (Phase 1 and Phase 2) need to coordinate; safest to land Phase 1 first, then Phase 2 adds the hook to BOTH packages in the same Phase 2 commit.

- [ ] **Step 3: Run admin route tests, expect PASS**
- [ ] **Step 4: Commit**: `feat(onboarding): POST /setup/admin + auth:complete-bootstrap-user hook`

### Task 2.7 — `POST /setup/model` route (validate API key + tx + Default Agent + bootstrap:complete)

**Files:**
- Modify: `packages/onboarding/src/routes.ts`
- Create: `packages/onboarding/src/completion-tx.ts`
- Create: `packages/onboarding/src/__tests__/model-route.test.ts`

This is the most failure-mode-rich route. Tests cover I8 (timeout) and I9 (transaction rollback).

- [ ] **Step 1: Add `models:list-supported` to `@ax/llm-anthropic` (prerequisite)**

```ts
// packages/llm-anthropic/src/plugin.ts (add to manifest.services and register)
ctx.registerService('models:list-supported', () => ({
  models: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', kind: 'fast' as const },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' as const },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', kind: 'default' as const },
  ],
}));
```

Test: `packages/llm-anthropic/src/__tests__/models-list.test.ts` — assert hook returns the expected shape.

- [ ] **Step 2: Failing test for /setup/model**

```ts
describe('POST /setup/model', () => {
  // Helper: completeAdminStep() returns the auth cookie after admin step.
  it('happy path with valid key: writes credential + Default Agent + status=completed', async () => {
    const cookie = await harness.completeAdminStep();
    harness.mockAnthropicValidationResponse(200);  // mock LLM 200s on probe
    const res = await fetch(`${baseUrl}/setup/model`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-ant-fake' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).next).toBe('/');
    // Assertions on DB state:
    expect((await harness.callService('bootstrap:status')).status).toBe('completed');
    const creds = await harness.callService('credentials:list', { scope: 'global' });
    expect(creds.credentials.find((c: any) => c.kind === 'anthropic-api-key')).toBeDefined();
    const agents = await harness.callService('agents:list', { ownerType: 'user' });
    expect(agents.agents.find((a: any) => a.name === 'Default Agent')).toBeDefined();
  });

  it('I8 — invalid key: 200 with {ok:false, reason:credential-invalid}, NO db writes', async () => {
    const cookie = await harness.completeAdminStep();
    harness.mockAnthropicValidationResponse(401);
    const res = await fetch(`${baseUrl}/setup/model`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-ant-bad' }) });
    expect((await res.json()).ok).toBe(false);
    const creds = await harness.callService('credentials:list', { scope: 'global' });
    expect(creds.credentials.length).toBe(0);
    const agents = await harness.callService('agents:list', { ownerType: 'user' });
    expect(agents.agents.length).toBe(0);
  });

  it('I8 — validation timeout: 200 with reason=credential-validation-timeout, NO db writes', async () => {
    const cookie = await harness.completeAdminStep();
    harness.mockAnthropicValidationDelay(15_000);  // > 10s timeout
    const res = await fetch(`${baseUrl}/setup/model`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-ant-slow' }) });
    expect((await res.json()).reason).toBe('credential-validation-timeout');
  }, 30_000);

  it('I9 — agent-insert failure rolls back credential', async () => {
    const cookie = await harness.completeAdminStep();
    harness.mockAnthropicValidationResponse(200);
    harness.injectAgentInsertFailure();  // make agents:create throw
    const res = await fetch(`${baseUrl}/setup/model`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-ant-fake' }) });
    expect(res.status).toBe(500);
    const creds = await harness.callService('credentials:list', { scope: 'global' });
    expect(creds.credentials.length).toBe(0);  // <-- I9
    expect((await harness.callService('bootstrap:status')).status).toBe('claimed');  // not completed
  });
});
```

- [ ] **Step 3: Implement `completion-tx.ts`**

```ts
// packages/onboarding/src/completion-tx.ts
export async function runCompletionTransaction(
  ctx: AgentContext,
  input: { adminUserId: string; apiKey: string; fastModel: string; defaultModel: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Step 1 — validate API key by hitting the LLM with max_tokens=1.
  // Hard 10s timeout (Invariant I8).
  const validation = await Promise.race([
    ctx.callService('llm:probe-credential', { kind: 'anthropic-api-key', value: input.apiKey, model: input.defaultModel }),
    new Promise<{ ok: false; reason: 'credential-validation-timeout' }>((res) =>
      setTimeout(() => res({ ok: false, reason: 'credential-validation-timeout' }), 10_000),
    ),
  ]);
  if (!validation.ok) return { ok: false, reason: validation.reason ?? 'credential-invalid' };

  // Step 2-4 — single DB transaction for credential + agent + bootstrap:complete.
  // The hook bus exposes ctx.transaction() for this — see existing usage in
  // @ax/credentials/src/plugin.ts for the pattern.
  await ctx.transaction(async (tx) => {
    const { credentialId } = await tx.callService('credentials:create', {
      kind: 'anthropic-api-key',
      scope: 'global',
      value: input.apiKey,
    });
    await tx.callService('agents:create', {
      name: 'Default Agent',
      ownerType: 'user',
      ownerId: input.adminUserId,
      runner: 'claude-sdk-runner',
      fastModel: input.fastModel,
      defaultModel: input.defaultModel,
      credentialId,
    });
    await tx.callService('bootstrap:complete', {});
  });

  return { ok: true };
}
```

> **Note on `llm:probe-credential`:** This hook may not exist. If `@ax/llm-anthropic` doesn't expose it, add it as part of Task 2.7 (small companion task in the same PR). Implementation: a 1-token completion call against the Anthropic API, returning `{ ok: true }` on 200, `{ ok: false, reason: 'credential-invalid' }` on 401. Reuses existing Anthropic client code in the package.

- [ ] **Step 4: Implement `handleModel` route**

```ts
async function handleModel(ctx: AgentContext, req: HttpRequest): Promise<HttpResponse> {
  const user = await requireAuthenticatedUser(ctx, req);
  if (!user) return { status: 401 };
  const { apiKey, models } = await req.json();
  if (typeof apiKey !== 'string') return { status: 400 };
  const fastModel = models?.fast ?? 'claude-haiku-4-5-20251001';
  const defaultModel = models?.default ?? 'claude-sonnet-4-6';
  const result = await runCompletionTransaction(ctx, {
    adminUserId: user.id,
    apiKey,
    fastModel,
    defaultModel,
  });
  if (!result.ok) return { status: 200, body: result };
  return { status: 200, body: { ok: true, next: '/' } };
}
```

- [ ] **Step 5: Run model-route tests, expect 4/4 PASS**
- [ ] **Step 6: Commit**: `feat(onboarding): POST /setup/model with synchronous validation + tx (I8, I9)`

### Task 2.8 — Wizard SPA (Vite-built, served from /setup)

**Files:**
- Create: `packages/onboarding/src/spa/{index.html,wizard.tsx,step-gate.tsx,step-admin.tsx,step-model.tsx,step-done.tsx,api-client.ts,vite.config.ts}`
- Modify: `packages/onboarding/package.json` (build script invokes vite)

The SPA is small (4 screens, no routing library). Each step is a React component that POSTs to its endpoint and advances on `next`.

- [ ] **Step 1: Vite config builds to `dist-spa/`**

```ts
// packages/onboarding/src/spa/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: { outDir: '../../dist-spa', emptyOutDir: true },
});
```

- [ ] **Step 2: `wizard.tsx` — root component with step state machine**

```tsx
// packages/onboarding/src/spa/wizard.tsx
import { useEffect, useState } from 'react';
import { StepGate } from './step-gate.js';
import { StepAdmin } from './step-admin.js';
import { StepModel } from './step-model.js';
import { StepDone } from './step-done.js';

type Step = 'gate' | 'admin' | 'model' | 'done';

export function Wizard() {
  const [step, setStep] = useState<Step>('gate');
  const [autoToken, setAutoToken] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const t = params.get('token');
    if (t) {
      setAutoToken(t);
      // Strip token from URL bar without reload.
      history.replaceState({}, '', location.pathname);
    }
  }, []);

  if (step === 'gate') return <StepGate autoToken={autoToken} onClaimed={() => setStep('admin')} />;
  if (step === 'admin') return <StepAdmin onCreated={() => setStep('model')} />;
  if (step === 'model') return <StepModel onComplete={() => setStep('done')} />;
  return <StepDone />;
}
```

- [ ] **Step 3-6: Each step component (≤ 60 lines each)**. Match the wireframes from `.superpowers/brainstorm/<session>/content/wizard-flow.html`.

For step-admin, the copy is exactly: "You'll be the first admin. We'll add other authentication methods later." (per spec §2 and the visual mockup).

- [ ] **Step 7: Add `GET /setup` and `GET /setup/static/*` routes that serve the built SPA**

The plugin reads `dist-spa/` at init time and registers static file handlers. Note: after `bootstrap:complete`, all `/setup/*` paths return 410 — including the SPA bundle. (Invariant I11.)

- [ ] **Step 8: Build wizard SPA + smoke test it loads**

```bash
pnpm --filter @ax/onboarding build
# Then `pnpm --filter @ax/cli serve` and curl http://localhost:8080/setup
```

- [ ] **Step 9: Commit**: `feat(onboarding): wizard SPA (4 screens) + /setup routes`

### Task 2.9 — End-to-end happy path test

**Files:**
- Create: `packages/onboarding/src/__tests__/e2e-happy.test.ts`

This is the canary that proves the whole wizard works against real testcontainer-postgres + auth-oidc + credentials + agents. If this passes, Phase 2 is done.

- [ ] **Step 1: Write the failing E2E test**

```ts
describe('Onboarding wizard — end-to-end happy path', () => {
  // Boot a kernel with: storage-postgres + auth-oidc + credentials + agents + onboarding + llm-anthropic (mocked)
  // Capture stdout to extract the bootstrap token.
  it('completes from cold boot to chat-ready in 3 HTTP calls', async () => {
    const { token, baseUrl } = await bootKernelAndCaptureToken();

    // 1. Claim
    const c1 = await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token }) });
    expect(c1.status).toBe(200);
    const bootstrapCookie = c1.headers.get('set-cookie')!;

    // 2. Admin
    const c2 = await fetch(`${baseUrl}/setup/admin`, {
      method: 'POST', headers: { cookie: bootstrapCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Vinay', email: 'v@x.com', password: 'longenoughpassword' }),
    });
    expect(c2.status).toBe(200);
    const authCookies = c2.headers.getSetCookie();
    const authCookie = authCookies.find(c => c.startsWith('ax_auth_session=')).split(';')[0];

    // 3. Model (with mocked anthropic returning 200 on probe)
    mockAnthropicProbeOnce(200);
    const c3 = await fetch(`${baseUrl}/setup/model`, {
      method: 'POST', headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-ant-test' }),
    });
    expect(c3.status).toBe(200);
    expect((await c3.json()).next).toBe('/');

    // 4. Verify we're chat-ready
    const me = await fetch(`${baseUrl}/admin/me`, { headers: { cookie: authCookie } });
    expect((await me.json()).user.isAdmin).toBe(true);

    const agents = await fetch(`${baseUrl}/api/agents`, { headers: { cookie: authCookie } });
    expect((await agents.json()).agents).toHaveLength(1);
    expect((await agents.json()).agents[0].name).toBe('Default Agent');

    // 5. Verify post-completion lockdown (I11)
    const lockedClaim = await fetch(`${baseUrl}/setup/claim`, { method: 'POST', body: JSON.stringify({ token }) });
    expect(lockedClaim.status).toBe(410);
  });
});
```

- [ ] **Step 2: Run, expect PASS**
- [ ] **Step 3: Commit**: `feat(onboarding): end-to-end happy path test (canary)`

### Task 2.10 — Wire `@ax/onboarding` into CLI + k8s presets (closes Phase 2 half-wired window for I3)

**Files:**
- Modify: `packages/cli/src/main.ts` (add `createOnboardingPlugin()`)
- Modify: deploy chart values + onboarding env passthrough

- [ ] **Step 1: Add to CLI preset**

```ts
// packages/cli/src/main.ts (line ~30 area)
import { createOnboardingPlugin } from '@ax/onboarding';

// In the plugin assembly (around line 153):
plugins.push(createOnboardingPlugin());
```

- [ ] **Step 2: Add to k8s preset**

Find the package that owns the k8s preset (likely `packages/preset-multi-tenant` or similar — `find packages -name "preset*" -type d`). Add `createOnboardingPlugin` similarly.

> **If no separate preset package exists**, the chart's pod just runs the CLI binary, in which case the CLI preset change in Step 1 IS the k8s preset change. Verify by checking `deploy/charts/ax/templates/deployment.yaml`.

- [ ] **Step 3: Update `deploy/charts/ax/values.yaml`**

Add:
```yaml
onboarding:
  # Optional: if set, ax does not auto-generate a bootstrap token.
  bootstrapToken: ""  # AX_BOOTSTRAP_TOKEN
```

And in `deployment.yaml`, surface `AX_BOOTSTRAP_TOKEN` as an env var.

- [ ] **Step 4: Run the full E2E test (Task 2.9) AGAIN to confirm preset wiring**

```bash
pnpm --filter @ax/onboarding test
pnpm --filter @ax/cli test
```

- [ ] **Step 5: Manual smoke against local docker-compose / kind**

```bash
make dev-fast  # or equivalent
docker logs <container> | grep ax_bs_  # token visible
# Open browser, walk wizard, verify chat works
```

- [ ] **Step 6: Commit**: `feat(onboarding): wire into CLI + k8s presets (closes I3 half-wired window)`

---

## Phase 3 — Switch presets to `@ax/auth-better` + `/admin/auth` UI + Admin entry

**Goal:** Close the auth-better half-wired window from Phase 1 and the wizard-to-/admin-auth gap from Phase 2. After this PR: presets load `@ax/auth-better` instead of `@ax/auth-oidc`; admin can configure Google/GitHub OAuth providers from `/admin/auth`; user menu has an "Admin" link visible to admins.

**Half-wired-window status:** This PR CLOSES the windows opened by Phases 1 and 2. PR notes must say so explicitly.

### Task 3.1 — `auth:complete-bootstrap-user` in `@ax/auth-better`

**Files:**
- Modify: `packages/auth-better/src/plugin.ts`
- Modify: `packages/auth-better/src/__tests__/bootstrap-user.test.ts`

Phase 2 added this hook in `@ax/auth-oidc`. Now `@ax/auth-better` needs the same hook to satisfy the boundary contract.

- [ ] **Steps 1-3:** Mirror the auth-oidc impl. Test: `auth:complete-bootstrap-user` with a valid `oneTimeToken` + password → returns a session cookie.

### Task 3.2 — Switch CLI preset from auth-oidc to auth-better

**Files:**
- Modify: `packages/cli/src/main.ts`

```diff
-import { createAuthPlugin } from '@ax/auth-oidc';
+import { createAuthBetterPlugin } from '@ax/auth-better';

-plugins.push(createAuthPlugin(authConfig));
+plugins.push(createAuthBetterPlugin(authBetterConfig));
```

- [ ] **Step 1**: Make the swap. Drop the env-driven Google client id/secret reading; auth-better reads providers from DB.
- [ ] **Step 2**: Run `pnpm --filter @ax/cli test`. Ensure existing CLI tests still pass.
- [ ] **Step 3**: Commit.

### Task 3.3 — Switch k8s preset / chart from auth-oidc to auth-better

Same change in chart values: deprecate `AUTH_GOOGLE_CLIENT_ID/SECRET` env vars (they're DB-driven now). Document migration in PR notes.

### Task 3.4 — `/admin/auth/providers/*` routes are already there from Phase 1

The CRUD routes from Task 1.5 are mounted by `@ax/auth-better`. After Phase 3.2, they're reachable. Verify with the hot-reload test from Task 1.5 — it should still pass against the live preset.

### Task 3.5 — `/admin/auth` UI (channel-web)

**Files:**
- Create: `packages/channel-web/src/components/admin/AuthProvidersTab.tsx`
- Create: `packages/channel-web/src/components/admin/AddProviderForm.tsx`
- Modify: `packages/channel-web/src/components/admin/AdminPane.tsx` (register the tab)
- Create: `packages/channel-web/src/__tests__/admin-auth-providers.test.tsx`

Follows the existing `ProviderKeysTab.tsx` pattern (PR #51).

- [ ] **Steps**: TDD a tab that lists providers (GET), supports Add (POST), Toggle (PATCH enabled), Delete (DELETE). Each operation hits the endpoints from Task 1.5.

> **YAGNI check:** Don't pre-build all 4 provider type forms if only Google is the immediate need. Ship Google + GitHub + generic OIDC in one form with a `kind` dropdown. Don't add Microsoft / Apple / etc. unless the user asks.

### Task 3.6 — User menu "Admin" link

**Files:**
- Modify: `packages/channel-web/src/components/UserMenu.tsx`
- Modify: `packages/channel-web/src/__tests__/user-menu.test.tsx`

```tsx
// UserMenu.tsx — add to the menu items array
{user.isAdmin && (
  <MenuItem href="/admin">
    <ShieldIcon /> Admin
  </MenuItem>
)}
```

Test: an admin user sees the link; a non-admin user does not.

### Task 3.7 — Run all integration tests + manual acceptance

```bash
pnpm test
make dev-fast  # or equivalent
# Manually: complete wizard, click Admin, add Google provider, sign out, sign in via Google.
```

PR notes for Phase 3 must include:
- "Half-wired window from Phase 1 (auth-better unloaded): CLOSED."
- "Half-wired window from Phase 2 (admin can't configure OAuth from UI): CLOSED."
- "auth-oidc still in tree as fallback alternate-impl. Not loaded by default presets."

---

## Phase 4 — Credentials cleanup (closes I12)

**Goal:** Drop the OAuth web-paste credential flow from the UI and unload the OAuth credential plugins from default presets. After this PR, the only way to add an LLM provider credential is an API key.

### Task 4.1 — Remove "Sign in with Claude" UI button

**Files:**
- Modify: `packages/channel-web/src/components/credentials/CredentialAddMenu.tsx`
- Delete: `packages/channel-web/src/components/credentials/OAuthFlowForm.tsx`
- Modify: tests in `__tests__/admin-credentials-add.test.tsx`

The "Sign in with Claude" CTA + `OAuthFlowForm` go away entirely. Only `ApiKeyForm` remains.

- [ ] **Step 1**: Read current state of `CredentialAddMenu.tsx`.
- [ ] **Step 2**: Strip the OAuth path, leaving only API-key entry.
- [ ] **Step 3**: Update tests to assert the OAuth option is no longer rendered.
- [ ] **Step 4**: Delete `OAuthFlowForm.tsx`.
- [ ] **Step 5**: Commit.

### Task 4.2 — Unload `credentials-anthropic-oauth` and `credentials-oauth-pending` from CLI preset

**Files:**
- Modify: `packages/cli/src/main.ts:16,153`

```diff
-import { createCredentialsAnthropicOauthPlugin } from '@ax/credentials-anthropic-oauth';
-plugins.push(createCredentialsAnthropicOauthPlugin());
```

The packages stay in the tree. Their tests still run independently. The plugins just aren't loaded.

### Task 4.3 — Same change in k8s preset / chart

### Task 4.4 — Verification: /admin/credentials shows only API-key entry

Manual + automated test: complete wizard → navigate to /admin/credentials → "Add credential" only offers API-key. No "Sign in with Claude".

### Task 4.5 — Document the cleanup follow-up

Add a stub to `docs/plans/2026-05-08-first-use-onboarding-followup.md`: "Phase 4 unloads `@ax/credentials-anthropic-oauth` and `@ax/credentials-oauth-pending` from default presets. Code remains in tree. A future cleanup PR (separate from this work) deletes the packages outright once we're sure no off-default preset depends on them."

PR notes for Phase 4: "I12 — provider credentials API-key-only: CLOSED."

---

## Phase 5 — CLI tools + manual acceptance

**Goal:** Recovery paths and the canonical first-use walkthrough.

### Task 5.1 — `ax admin reset-bootstrap` CLI

**Files:**
- Create: `packages/cli/src/commands/admin/reset-bootstrap.ts`
- Modify: `packages/cli/src/commands/admin.ts` (add subcommand)
- Create: `packages/cli/src/__tests__/admin-reset-bootstrap.test.ts`

Behavior:
- `ax admin reset-bootstrap` (no flags): refuses if `bootstrap_state.status === 'completed'`. Else mints a new token, hashes it, updates `bootstrap_state` to `pending`, prints token + URL.
- `ax admin reset-bootstrap --force`: allowed regardless of status. Same effect.
- Tests: each branch.

### Task 5.2 — `ax admin reset-password` CLI

**Files:**
- Create: `packages/cli/src/commands/admin/reset-password.ts`
- Modify: `packages/cli/src/commands/admin.ts`
- Create: `packages/cli/src/__tests__/admin-reset-password.test.ts`

Behavior:
- `ax admin reset-password --email me@x.com`: looks up user by email; mints a one-shot reset token; prints `https://localhost:8080/auth/reset-password?token=...`. Token TTL: 30 min.
- The `/auth/reset-password` route is a small new addition to `@ax/auth-better` (small companion task in this PR).

### Task 5.3 — MANUAL-ACCEPTANCE walkthrough

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

Add three sections:

1. **First-use happy path**: bring up `ax-next-dev` kind cluster fresh, follow magic link, walk all 3 steps with a real Anthropic API key, send chat message, get response.
2. **Recovery — lost bootstrap token**: nuke `/var/run/ax/bootstrap-token`, run `ax admin reset-bootstrap`, walk wizard.
3. **Recovery — lost password**: complete wizard normally, run `ax admin reset-password --email me@x.com`, follow reset link, sign in with new password.

Use the `k8s-acceptance-loop` skill to walk these end-to-end with Playwright before claiming Phase 5 done.

### Task 5.4 — Final integration smoke

```bash
pnpm test
pnpm lint
pnpm build
```

PR notes for Phase 5: all I1-I12 invariants closed. Spec §1-§5 acceptance criteria all checked.

---

## Self-review — spec coverage check

Walking the spec section by section against the plan:

- **§Architecture** — `@ax/onboarding` (Phase 2), `@ax/auth-better` (Phase 1), reused plugins (no work), hook surface table (Phases 1, 2 add the new hooks), boundary review (in PR notes for each phase). ✓
- **§1 Bootstrap token lifecycle** — generation (Task 2.4), consumption (Task 2.5), magic link (Task 2.8 SPA), closing the window (Task 2.7 transaction), recovery (Task 5.1 + 5.2). ✓
- **§2 Auth — wizard step 1 + post-wizard** — `auth:create-bootstrap-user` reused (Task 1.4), `auth:complete-bootstrap-user` added (Tasks 2.6, 3.1), dynamic provider config (Tasks 1.5, 3.5), `/admin/auth` UI (Task 3.5). ✓
- **§3 Wizard step 2 — API key credential** — UI (Task 2.8 step-model), backend (Task 2.7), synchronous validation (Task 2.7 with I8 timeout), Default Agent (Task 2.7 transaction), `models:list-supported` (Task 2.7 step 1), scope addition cleanup (Phase 4). ✓
- **§4 Post-wizard /admin surfaces** — /admin/auth (Task 3.5), /admin/credentials cleanup (Task 4.1), /admin/agents reuse (no work — PR #51 sufficient), user-menu Admin entry (Task 3.6), permission gating (referenced throughout). ✓
- **§5 Testing & failure modes** — unit tests woven through every task; integration in Tasks 2.9, 1.5, 2.7; manual acceptance in Task 5.3; failure modes (panic-on-print-fail, hot-reload-resilience, validation timeout, tx rollback) all have explicit tests. ✓
- **§Forward-compatibility flags** — multi-tenant SaaS, SMTP, second LLM provider — all called out as deliberately-deferred in PR notes; no plan tasks. ✓
- **§Acceptance criteria 1-5** — covered by Tasks 2.9 (criteria 1, 5), 5.3 (manual walks for criteria 1, 2), 3.7 (criterion 3), 4.4 (criterion 4). ✓

**Type consistency check:** `User` is the boundary type from `@ax/auth-oidc/types.ts`, re-exported by `@ax/auth-better`. `bootstrap_state.status` is `'pending' | 'claimed' | 'completed'` everywhere. Hook payload field names (`token`, `apiKey`, `displayName`, `oneTimeToken`) match across tasks.

**Placeholder scan:** No "TBD" or "TODO" in plan body. Each step has either exact code or an explicit pointer to a file the implementer should read first.

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-05-08-first-use-onboarding-impl.md`.**

Phases are PR-shippable units. Phase 1 and Phase 2 can ship in parallel (Phase 2 doesn't depend on Phase 1). Phase 3 depends on both. Phase 4 is independent. Phase 5 depends on Phase 3 (it adds CLI tools that touch auth-better's reset hook).

Execution options:

1. **Subagent-Driven** (recommended for a plan this size) — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach do you want — and which phase first? My recommendation: start with Phase 1 (auth-better plugin) under subagent-driven mode, since it's the substrate the rest of the plan rests on.
