# JIT Per-`(user, agent)` Host-Grant Store ("Always Allow") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reactive egress wall's **"Always for this agent"** button durable — a new `@ax/host-grants` plugin persists a per-`(user, agent)` allow-list of hosts, the chat-orchestrator loads those hosts into the egress allowlist at every fresh session open, and a `host-grants:revoke` hook exists for the settings mirror (TASK-42). This closes TASK-37's half-wired window #1 (where "Always" did only a live grant that died with the session).

**Architecture:** Three moving parts on top of the merged TASK-37 reactive wall. (1) **Store** — a new DB-backed plugin `@ax/host-grants` owns `host_grants_v1_grants` (compound PK `owner_user_id, agent_id, host`) and registers three host-internal service hooks: `host-grants:grant` / `host-grants:list` / `host-grants:revoke`. (2) **Load** — `@ax/chat-orchestrator` calls `host-grants:list({ ownerUserId, agentId })` at session open (the same `hasService`-gated, conditionally-called convention it uses for `skills:list-user-attachments`) and unions the hosts into the allowlist it passes to `proxy:open-session`. (3) **Persist** — the existing `POST /api/chat/allow-host` route gains a `persist` flag; when set, after the live `proxy:add-host` grant it also calls `host-grants:grant`. The `(user, agent)` key is **authoritative**: `userId` from the auth cookie, `agentId` returned by `proxy:add-host` from the proxy's own `SessionConfig` (the proxy is the source of truth for session→agent) — the untrusted browser never supplies the grant key.

**Tech Stack:** TypeScript, pnpm workspace, tsconfig project refs, kysely + Postgres (testcontainers in tests), the in-process hook bus (`bus.call`/`bus.hasService` + Zod `returns` schemas), zod, React + shadcn primitives in `packages/channel-web`, vitest (+ `@testing-library/react` jsdom).

---

## Scope guardrails

- **Hook-surface changes (boundary review below):**
  - **New** service hooks `host-grants:grant` / `host-grants:list` / `host-grants:revoke` in `@ax/host-grants`.
  - **Changed** return shape of the existing `proxy:add-host`: `{ added: boolean }` → `{ added: boolean; agentId?: string }` (input `{ sessionId, host }` is **unchanged**).
- **Security-checklist applies (pre-PR gate).** This work widens a **future** session's egress allowlist from persisted state — squarely the egress trust boundary the design's §10 says the `security-checklist` skill MUST cover. Pre-stated threat model is below; run the skill before opening the PR even though the card body didn't literally tag it (the egress-widening persistence is the trigger).
- **Half-wired window:** `host-grants:revoke` has no production **UI** caller until **TASK-42** (the settings "Allowed sites → Revoke" control, design §P3/§P6). It is fully reachable + tested here (plugin test + canary `grant → list → revoke` roundtrip), so the *plugin* is not half-wired (grant + list have live production callers); only the revoke hook's settings consumer is deferred. **CLOSES in TASK-42.** Stated in full below.

---

## Dependency status & as-built re-verification (READ FIRST)

This card depends only on **TASK-37** ("the live grant it complements"), which is **merged** (commit `2d6a2822`). `yolo-ship` pulls this card with TASK-37 on `main`, so the reactive wall (card + route + `proxy:add-host`) is present. This plan was written against the **as-built `main`** code (re-verified 2026-05-26, hard requirement #1 — do not trust design file:line anchors). Before Task 1, re-confirm each anchor below and adjust the diffs if anything moved:

- [ ] **`proxy:add-host` (as-built):** `packages/credential-proxy/src/plugin.ts` registers `'proxy:add-host'` (manifest `registers` ≈302; handler ≈559-596). It validates `host` with the module-level `HOST_RE` (≈ top of file), looks up `sessions.get(sessionId)`, returns `{ added: false }` for unknown/closed sessions, throws `forbidden` unless `sess.userId === ctx.userId`, then `sess.allowlist.add(host)` and returns `{ added: true }`. **Task 4 extends its return shape.**
- [ ] **`SessionConfig` (as-built):** `packages/credential-proxy/src/listener.ts` (≈54-115) carries `allowlist: Set<string>`, optional `sessionId`, optional `userId`, `classification`, `proxyToken` — but **no `agentId`** today. **Task 4 adds `agentId?: string`.** The `proxy:open-session` handler (`plugin.ts` ≈383-430) already receives `input.agentId: string` (the input type at ≈201-206 has `agentId`) and sets `userId`/`sessionId` on the new `SessionConfig` (≈420-430) — **Task 4 also sets `agentId` there.**
- [ ] **Orchestrator session-open union (as-built):** `packages/chat-orchestrator/src/orchestrator.ts` builds `baseAllowSet` from agent defaults + each attached skill's `capabilities.allowedHosts` (≈1253-1303), then adds package registries (≈1341-1352), then `const unionedAllowlist = [...baseAllowSet];` (≈1353) which it passes to `proxy:open-session` (≈1390-1399). The `skills:list-user-attachments` block (≈1190-1213) is the exact pattern Task 5 mirrors: `if (bus.hasService(...)) { try { ... } catch { ... } }`, gated by `hasService`, **NOT declared in the manifest** (see the comment at ≈1171-1185 — "conditionally called, NOT declared in the manifest"). `ctx.userId` and `agent.id` are both in scope at ≈1353.
- [ ] **Grant route (as-built):** `packages/channel-web/src/server/routes-allow-host.ts` — `makeAllowHostHandler({ bus, initCtx })`, `BodySchema = { sessionId, host }` (≈31-34), auth via `auth:require-user` → 401, builds a per-request ctx from the authed `userId` (≈90-95), calls `proxy:add-host` (≈97-101), maps `forbidden`→403 / `invalid-host`→400. **Task 6 adds the `persist` branch.** The route is registered in `packages/channel-web/src/server/plugin.ts` (`init`, mirror the registration near the other `http:register-route` calls); `proxy:add-host` is in that plugin's manifest `calls` (≈108-113). **Task 6 adds `host-grants:grant` to `optionalCalls`.**
- [ ] **Card + client (as-built):** `packages/channel-web/src/components/PermissionCard.tsx` host branch (≈127-160) has `allow()` (≈113-125) calling `grantHost({ sessionId, host })`; **both** "Always for this agent" and "Just this once" buttons call `() => void allow()` today (≈152-157). `packages/channel-web/src/lib/credentials.ts` `grantHost({ sessionId, host })` (≈189-200) POSTs to `/api/chat/allow-host` with `writeHeaders` (`x-requested-with: ax-admin`) + `credentials: 'include'`. **Task 7 adds the `persist` flag end-to-end.** The browser-facing `PermissionRequest` host variant `{ kind:'host'; host; sessionId }` (server `types.ts` ≈130, store `permission-card-store.ts` ≈33, transport `transport.ts` ≈140) is **unchanged** — `agentId` never flows to the browser (fork #2).
- [ ] **DB-backed plugin scaffold (as-built):** `@ax/skills` / `@ax/attachments` are the mirror for a new DB plugin — `database:get-instance` → shared `Kysely`, own `runXMigration(db)`, own `<plugin>_v1_*` tables, hooks register `returns` Zod schemas. `presets/k8s/src/index.ts` (≈699-715) wires `@ax/agents` + `@ax/skills`; `presets/k8s/package.json` lists each `@ax/*` as `workspace:*`; root `tsconfig.json` lists a `{ path: "packages/<name>" }` reference per package. The CLI preset (`packages/cli/src/main.ts`) uses **sqlite** and does **not** load DB-backed plugins — so `@ax/host-grants` is **k8s-preset-only** (Task 8).

---

## Implementation forks resolved (hard requirement #7)

> **Fork 1 — where the persistent store lives → a NEW `@ax/host-grants` plugin (not an existing plugin).**
> The persisted per-`(user, agent)` host list is a distinct concept that needs durable storage, so by invariant #4 it needs its own owner. No existing plugin is a clean home: `@ax/credential-proxy` is host-internal, session-scoped, and deliberately **storage-free** (it has no `database:get-instance` dependency; bolting a durable per-user store onto a security-critical egress gate widens its responsibility and failure modes); `@ax/agents` is **admin/agent-global** (per-user overlays deliberately live *outside* it — e.g. per-user skill attachments live in `@ax/skills`, not agents); `@ax/skills` is the skill domain (host grants aren't skills); `@ax/credentials` is for secrets (a host is not a secret). A dedicated plugin mirrors the established domain-plugin pattern (`<plugin>_v1_*` table + store + `returns`-validated hooks, DB via `database:get-instance`) and gives a minimal, clean boundary. The boilerplate is mechanical (Tasks 1-3).
>
> **Fork 2 — how the persist path gets a trustworthy `(user, agent)` key → derive `agentId` from the proxy session, never from the browser.**
> The grant key is `(userId, agentId, host)`. `userId` is already authoritative (the route builds ctx from the auth cookie). For `agentId`, the **credential-proxy is the source of truth for session→agent** (it receives `agentId` at `proxy:open-session` today and currently discards it). **Resolution:** store `agentId` on `SessionConfig` and have `proxy:add-host` return it (it already holds the session and does the `userId === ctx.userId` ownership check). The route then persists under `{ ownerUserId: <authed userId>, agentId: <proxy-returned>, host }`. The **browser supplies only `sessionId` (re-validated) + a `persist` boolean** — it never supplies the grant key, so a tampered/forged value can't mis-key a grant.
> *Alternative considered & rejected:* thread `agentId` to the browser-facing card (orchestrator/sse → store → transport → card → route body) and echo it back. Rejected because (a) it trusts the untrusted client for a key field, and (b) it touches ~5 more `channel-web` files plus a type-separation headache (the orchestrator-fired host payload has no `agentId`, so the browser-facing `PermissionRequest` would diverge from the wire payload). Deriving `agentId` server-side is both **more secure** (invariant #5) and **smaller**.
> *This is not a human-only call:* cross-user isolation is guaranteed by the authoritative `userId` under either fork; `agentId` only partitions a user's own grants. Resolving it as above is the strictly-safer engineering choice.

---

## Boundary review for the new / changed hooks (per CLAUDE.md)

**`host-grants:grant` / `host-grants:list` / `host-grants:revoke`** (new, in `@ax/host-grants`):
- **Alternate impl:** a JSON column on a per-user-agent record, a generic `storage:set` prefix store, or a non-SQL backend. The hooks say "remember / enumerate / forget the hosts this `(user, agent)` always allows" without naming storage.
- **Fields:** in `{ ownerUserId, agentId, host }` (+ `{ ownerUserId, agentId }` for list); out `{ created }` / `{ hosts: { host, grantedAt }[] }` / `{ revoked }`. `grantedAt` is a generic ISO timestamp, not a DB token. No `sha`/`pod`/`socket`/`bucket`/`oid`/`generation`/`lsn` vocabulary — no leak.
- **Subscriber risk:** none — single-impl service hooks, not broadcasts.
- **Wire surface:** **NOT IPC actions.** The untrusted runner must never grant/list/revoke its own persistent egress — identical reasoning to TASK-37's `proxy:add-host` (fork #1). The only callers are host-side: the orchestrator (session open) and the user-gated, CSRF-protected `allow-host` route. No schema in a central file.
- **`agent_id` is an opaque scoping key** — no FK to `agents_v1_agents` (cross-plugin FKs are banned; a dangling grant to a deleted agent simply never loads).

**`proxy:add-host` return change** `{ added }` → `{ added; agentId? }`:
- **Field:** `agentId` is a domain id the proxy already accepts at `open-session`; returning it to the host-internal caller leaks no backend vocabulary. `agentId` is present iff `added` is true (a session was found + owned).
- **Subscriber risk:** none (single-impl service hook). **Still host-internal — not an IPC action** (unchanged from TASK-37).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/host-grants/package.json` | new plugin package manifest | **create** |
| `packages/host-grants/tsconfig.json` | TS project refs | **create** |
| `packages/host-grants/src/index.ts` | public exports | **create** |
| `packages/host-grants/src/migrations.ts` | `host_grants_v1_grants` DDL + row/DB types | **create** |
| `packages/host-grants/src/host-validate.ts` | exact-match hostname validator (pure fn, re-impl per I2) | **create** |
| `packages/host-grants/src/store.ts` | `grant` / `list` / `revoke` + per-`(user,agent)` cap | **create** |
| `packages/host-grants/src/types.ts` | hook I/O types + Zod `returns` schemas | **create** |
| `packages/host-grants/src/plugin.ts` | the three service hooks + manifest | **create** |
| `packages/host-grants/src/__tests__/migrations.test.ts` | table + compound-PK (testcontainers) | **create** |
| `packages/host-grants/src/__tests__/store.test.ts` | store roundtrip + cap (testcontainers) | **create** |
| `packages/host-grants/src/__tests__/plugin.test.ts` | hooks over a bus harness | **create** |
| `packages/host-grants/src/__tests__/host-grants.canary.test.ts` | grant → list → revoke e2e + bad host (testcontainers) | **create** |
| `tsconfig.json` (root) | project references | **add** `{ "path": "packages/host-grants" }` |
| `packages/credential-proxy/src/listener.ts` | `SessionConfig` | **add** `agentId?: string` |
| `packages/credential-proxy/src/plugin.ts` | `proxy:open-session` + `proxy:add-host` | **set** `agentId` on session; **return** it from add-host |
| `packages/credential-proxy/src/__tests__/plugin.test.ts` | proxy hook tests | **update** add-host return assertions |
| `packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts` | reactive-wall canary | **update** add-host return assertion |
| `packages/chat-orchestrator/src/orchestrator.ts` | session-open allowlist union | **add** `host-grants:list` union (hasService-gated, fail-open) |
| `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` | orchestrator tests | **add** union + fail-open cases |
| `packages/channel-web/src/lib/credentials.ts` | `grantHost` client helper | **add** `persist?: boolean` |
| `packages/channel-web/src/components/PermissionCard.tsx` | host-grant card | **branch** the two buttons → `allow(persist)` |
| `packages/channel-web/src/__tests__/permission-card.test.tsx` | card component test | **update** "Always" → persist:true |
| `packages/channel-web/src/server/routes-allow-host.ts` | grant route | **add** `persist` + post-grant `host-grants:grant` |
| `packages/channel-web/src/server/plugin.ts` | channel-web manifest | **add** `host-grants:grant` to `optionalCalls` |
| `packages/channel-web/src/__tests__/server/routes-allow-host.test.ts` | route test | **add** persist branch cases |
| `presets/k8s/src/index.ts` | k8s assembly | **wire** `createHostGrantsPlugin()` |
| `presets/k8s/package.json` | preset deps | **add** `@ax/host-grants: workspace:*` |
| `presets/k8s/src/__tests__/preset.test.ts` | preset boot/manifest test | **assert** the plugin loads + registers `host-grants:*` |
| `.changeset/jit-host-grants-store.md` | release note | **create** |

---

## Shared rule: hostname validity + grant cap (referenced by Tasks 1, 2, 3)

A **valid grant host** is the same exact-match hostname the proxy's allowlist accepts — re-implemented **independently** in `@ax/host-grants` (no import from `@ax/credential-proxy`, invariant I2):

```typescript
// Exact-match allowlist hostnames only: no wildcards, no ports, no schemes,
// no uppercase. Mirrors @ax/credential-proxy's HOST_RE (capability minimized).
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
```

**Cap:** at most **256** persisted hosts per `(owner_user_id, agent_id)`. Bounds unbounded growth / abuse; a grant that would exceed it (for a host not already present) throws `grant-limit`. Granting an already-present host is an idempotent no-op (`{ created: false }`) and never counts against the cap.

These rules live in `@ax/host-grants` only (the single writer of the table). The orchestrator and route treat the host as opaque on read.

---

### Task 1: Scaffold `@ax/host-grants` + the `host_grants_v1_grants` table

**Files:**
- Create: `packages/host-grants/package.json`, `packages/host-grants/tsconfig.json`, `packages/host-grants/src/index.ts`, `packages/host-grants/src/migrations.ts`
- Modify: `tsconfig.json` (root)
- Test: `packages/host-grants/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Create the package scaffolding**

`packages/host-grants/package.json` (mirrors `@ax/skills`):

```json
{
  "name": "@ax/host-grants",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "kysely": "0.28.17",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@ax/database-postgres": "workspace:*",
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

`packages/host-grants/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

`packages/host-grants/src/index.ts` (start minimal; later tasks extend):

```typescript
export { runHostGrantsMigration, type HostGrantsDatabase, type HostGrantRow } from './migrations.js';
```

In root `tsconfig.json`, add to `references` (anywhere in the array):

```json
    { "path": "packages/host-grants" },
```

Then install so pnpm links the new workspace package:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing migration test**

`packages/host-grants/src/__tests__/migrations.test.ts` (mirrors `@ax/skills`'s testcontainers `makeKysely()` pattern):

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runHostGrantsMigration, type HostGrantsDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<HostGrantsDatabase>[] = [];

function makeKysely(): Kysely<HostGrantsDatabase> {
  const k = new Kysely<HostGrantsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try { await k.schema.dropTable('host_grants_v1_grants').ifExists().execute(); } catch { /* drained */ }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => { if (container) await container.stop(); });

describe('host_grants_v1_grants migration', () => {
  it('creates the table with the compound PK (owner_user_id, agent_id, host)', async () => {
    const db = makeKysely();
    await runHostGrantsMigration(db);

    await db.insertInto('host_grants_v1_grants').values([
      { owner_user_id: 'u1', agent_id: 'a1', host: 'a.example.com' },
      { owner_user_id: 'u1', agent_id: 'a1', host: 'b.example.com' },
      { owner_user_id: 'u1', agent_id: 'a2', host: 'a.example.com' }, // distinct agent → allowed
    ]).execute();

    const rows = await db.selectFrom('host_grants_v1_grants').selectAll()
      .where('owner_user_id', '=', 'u1').where('agent_id', '=', 'a1').orderBy('host').execute();
    expect(rows.map((r) => r.host)).toEqual(['a.example.com', 'b.example.com']);

    // Duplicate compound key rejected.
    await expect(
      db.insertInto('host_grants_v1_grants')
        .values({ owner_user_id: 'u1', agent_id: 'a1', host: 'a.example.com' }).execute(),
    ).rejects.toThrow();
  });

  it('is idempotent (running twice does not throw)', async () => {
    const db = makeKysely();
    await runHostGrantsMigration(db);
    await expect(runHostGrantsMigration(db)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @ax/host-grants test -- src/__tests__/migrations.test.ts`
Expected: FAIL — cannot find module `../migrations.js`.

- [ ] **Step 4: Implement the migration + types**

`packages/host-grants/src/migrations.ts`:

```typescript
import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/host-grants owns tables under the
 * `host_grants_v1_` prefix — never reach into them from another plugin
 * (Invariant I4 — one source of truth per concept). Additive-only.
 *
 * host_grants_v1_grants — the persistent per-(user, agent) "always-allow"
 * egress host list (JIT design §6B / §P7.3 / decision #12). The durable twin
 * of the LIVE proxy:add-host grant (TASK-37): the orchestrator loads these
 * hosts into the egress allowlist at every fresh session open. `agent_id` is
 * an opaque scoping key — no FK to agents_v1_agents (cross-plugin FKs are
 * banned; a dangling grant to a deleted agent simply never loads).
 */
export async function runHostGrantsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS host_grants_v1_grants (
      owner_user_id TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      host          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, host)
    )
  `.execute(db);
}

/** Row shape returned by postgres. */
export interface HostGrantRow {
  owner_user_id: string;
  agent_id: string;
  host: string;
  created_at: Date;
}

export interface HostGrantsDatabase {
  host_grants_v1_grants: HostGrantRow;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/host-grants test -- src/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/host-grants/package.json packages/host-grants/tsconfig.json packages/host-grants/src/index.ts packages/host-grants/src/migrations.ts packages/host-grants/src/__tests__/migrations.test.ts tsconfig.json pnpm-lock.yaml
git commit -m "feat(host-grants): scaffold @ax/host-grants + host_grants_v1_grants table"
```

---

### Task 2: The store — `grant` / `list` / `revoke` + host validator + cap

**Files:**
- Create: `packages/host-grants/src/host-validate.ts`, `packages/host-grants/src/store.ts`
- Test: `packages/host-grants/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-grants/src/__tests__/store.test.ts` (reuse the Task-1 testcontainers harness shape — copy the `beforeAll`/`afterEach`/`afterAll` + `makeKysely` block from `migrations.test.ts`):

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runHostGrantsMigration, type HostGrantsDatabase } from '../migrations.js';
import { createHostGrantsStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<HostGrantsDatabase>[] = [];
function makeKysely(): Kysely<HostGrantsDatabase> {
  const k = new Kysely<HostGrantsDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }) });
  opened.push(k);
  return k;
}
beforeAll(async () => { container = await new PostgreSqlContainer('postgres:16-alpine').start(); connectionString = container.getConnectionUri(); }, 120_000);
afterEach(async () => { while (opened.length > 0) { const k = opened.pop()!; try { await k.schema.dropTable('host_grants_v1_grants').ifExists().execute(); } catch { /* */ } await k.destroy().catch(() => {}); } });
afterAll(async () => { if (container) await container.stop(); });

async function freshStore() {
  const db = makeKysely();
  await runHostGrantsMigration(db);
  return createHostGrantsStore(db);
}

describe('host-grants store', () => {
  it('grant inserts; re-grant of the same host is idempotent (created:false)', async () => {
    const s = await freshStore();
    expect(await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({ created: true });
    expect(await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({ created: false });
    const hosts = await s.list('u1', 'a1');
    expect(hosts.map((h) => h.host)).toEqual(['x.example.com']);
    expect(typeof hosts[0]?.grantedAt).toBe('string'); // ISO timestamp for the settings mirror (TASK-42)
  });

  it('list is scoped to (user, agent) and ordered by host', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'b.example.com' });
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'a.example.com' });
    await s.grant({ ownerUserId: 'u1', agentId: 'a2', host: 'other.example.com' });
    await s.grant({ ownerUserId: 'u2', agentId: 'a1', host: 'leak.example.com' });
    expect((await s.list('u1', 'a1')).map((h) => h.host)).toEqual(['a.example.com', 'b.example.com']);
  });

  it('revoke deletes only the matching (user, agent, host) row', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' });
    expect(await s.revoke({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({ revoked: true });
    expect(await s.revoke({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({ revoked: false });
    expect(await s.list('u1', 'a1')).toEqual([]);
  });

  it('rejects an invalid host', async () => {
    const s = await freshStore();
    for (const host of ['', 'UPPER.example.com', 'has space', '*.example.com', 'host:8080', 'http://x.example.com']) {
      await expect(s.grant({ ownerUserId: 'u1', agentId: 'a1', host })).rejects.toThrow(/invalid host/i);
    }
  });

  it('enforces the 256-host cap per (user, agent)', async () => {
    const s = await freshStore();
    for (let i = 0; i < 256; i++) await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: `h${i}.example.com` });
    await expect(s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'overflow.example.com' })).rejects.toThrow(/grant-limit|at most 256/i);
    // Re-granting an existing host at the cap is still a no-op, never an error.
    expect(await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'h0.example.com' })).toEqual({ created: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/host-grants test -- src/__tests__/store.test.ts`
Expected: FAIL — cannot find module `../store.js`.

- [ ] **Step 3: Implement the validator + store**

`packages/host-grants/src/host-validate.ts`:

```typescript
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/host-grants';

// Exact-match allowlist hostnames only: no wildcards, no ports, no schemes,
// no uppercase. Re-implemented here (NOT imported from @ax/credential-proxy)
// per invariant I2 — each trust boundary validates independently.
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function assertValidHost(host: string): void {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new PluginError({
      code: 'invalid-host',
      plugin: PLUGIN_NAME,
      message: `invalid host: ${String(host)}`,
    });
  }
}
```

`packages/host-grants/src/store.ts`:

```typescript
/**
 * @ax/host-grants store. Every query is scoped to (owner_user_id, agent_id):
 * the scope-isolation boundary — user A's queries MUST NEVER touch user B's
 * rows, and agent a1's grants never bleed into a2.
 */
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { HostGrantsDatabase } from './migrations.js';
import { assertValidHost } from './host-validate.js';

const PLUGIN_NAME = '@ax/host-grants';
const MAX_GRANTS_PER_AGENT = 256;

export interface HostGrant {
  host: string;
  /** ISO-8601 grant timestamp. Surfaced by the settings mirror (TASK-42). */
  grantedAt: string;
}

export interface HostGrantsStore {
  grant(input: { ownerUserId: string; agentId: string; host: string }): Promise<{ created: boolean }>;
  list(ownerUserId: string, agentId: string): Promise<HostGrant[]>;
  revoke(input: { ownerUserId: string; agentId: string; host: string }): Promise<{ revoked: boolean }>;
}

export function createHostGrantsStore(db: Kysely<HostGrantsDatabase>): HostGrantsStore {
  return {
    async grant({ ownerUserId, agentId, host }) {
      assertValidHost(host);
      // Idempotent: an existing host is a no-op and never counts against the cap.
      const existing = await db
        .selectFrom('host_grants_v1_grants')
        .select('host')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('host', '=', host)
        .executeTakeFirst();
      if (existing !== undefined) return { created: false };

      const { count } = await db
        .selectFrom('host_grants_v1_grants')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_GRANTS_PER_AGENT) {
        throw new PluginError({
          code: 'grant-limit',
          plugin: PLUGIN_NAME,
          message: `at most ${MAX_GRANTS_PER_AGENT} host grants per (user, agent)`,
        });
      }

      // Accepted race (mirrors @ax/skills user-attachments-store): a concurrent
      // insert of the same compound key surfaces as a PK violation, fine at
      // user scale.
      await db
        .insertInto('host_grants_v1_grants')
        .values({ owner_user_id: ownerUserId, agent_id: agentId, host, created_at: new Date() })
        .execute();
      return { created: true };
    },

    async list(ownerUserId, agentId) {
      const rows = await db
        .selectFrom('host_grants_v1_grants')
        .select(['host', 'created_at'])
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .orderBy('host', 'asc')
        .execute();
      return rows.map((r) => ({ host: r.host, grantedAt: r.created_at.toISOString() }));
    },

    async revoke({ ownerUserId, agentId, host }) {
      const res = await db
        .deleteFrom('host_grants_v1_grants')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('host', '=', host)
        .executeTakeFirst();
      return { revoked: Number(res.numDeletedRows ?? 0n) > 0 };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/host-grants test -- src/__tests__/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host-grants/src/host-validate.ts packages/host-grants/src/store.ts packages/host-grants/src/__tests__/store.test.ts
git commit -m "feat(host-grants): grant/list/revoke store with host validation + per-(user,agent) cap"
```

---

### Task 3: The plugin — three service hooks (`returns`-validated) + manifest

**Files:**
- Create: `packages/host-grants/src/types.ts`, `packages/host-grants/src/plugin.ts`
- Modify: `packages/host-grants/src/index.ts`
- Test: `packages/host-grants/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-grants/src/__tests__/plugin.test.ts` (mirrors `@ax/skills`'s `createTestHarness` + `createDatabasePostgresPlugin` + testcontainers harness):

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createHostGrantsPlugin } from '../plugin.js';
import type {
  HostGrantsGrantInput, HostGrantsGrantOutput,
  HostGrantsListInput, HostGrantsListOutput,
  HostGrantsRevokeInput, HostGrantsRevokeOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), createHostGrantsPlugin()],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => { container = await new PostgreSqlContainer('postgres:16-alpine').start(); connectionString = container.getConnectionUri(); }, 120_000);
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try { await c.query('DROP TABLE IF EXISTS host_grants_v1_grants'); } finally { await c.end().catch(() => {}); }
});
afterAll(async () => { if (container) await container.stop(); });

describe('@ax/host-grants plugin', () => {
  it('manifest matches the documented surface', () => {
    expect(createHostGrantsPlugin().manifest).toEqual({
      name: '@ax/host-grants',
      version: '0.0.0',
      registers: ['host-grants:grant', 'host-grants:list', 'host-grants:revoke'],
      calls: ['database:get-instance'],
      subscribes: [],
    });
  });

  it('grant → list → revoke round-trips over the bus', async () => {
    const h = await makeHarness();
    const g = await h.bus.call<HostGrantsGrantInput, HostGrantsGrantOutput>(
      'host-grants:grant', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' });
    expect(g).toEqual({ created: true });

    const l = await h.bus.call<HostGrantsListInput, HostGrantsListOutput>(
      'host-grants:list', h.ctx(), { ownerUserId: 'u1', agentId: 'a1' });
    expect(l.hosts.map((x) => x.host)).toEqual(['x.example.com']);

    const r = await h.bus.call<HostGrantsRevokeInput, HostGrantsRevokeOutput>(
      'host-grants:revoke', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' });
    expect(r).toEqual({ revoked: true });
    expect((await h.bus.call<HostGrantsListInput, HostGrantsListOutput>('host-grants:list', h.ctx(), { ownerUserId: 'u1', agentId: 'a1' })).hosts).toEqual([]);
  });

  it('host-grants:grant rejects an invalid host', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('host-grants:grant', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: '*.evil.com' }),
    ).rejects.toThrow(/invalid host/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/host-grants test -- src/__tests__/plugin.test.ts`
Expected: FAIL — cannot find module `../plugin.js`.

- [ ] **Step 3: Implement the types**

`packages/host-grants/src/types.ts`:

```typescript
import { z } from 'zod';

export interface HostGrantsGrantInput { ownerUserId: string; agentId: string; host: string; }
export interface HostGrantsGrantOutput { created: boolean; }

export interface HostGrantsListInput { ownerUserId: string; agentId: string; }
export interface HostGrantsListOutput { hosts: { host: string; grantedAt: string }[]; }

export interface HostGrantsRevokeInput { ownerUserId: string; agentId: string; host: string; }
export interface HostGrantsRevokeOutput { revoked: boolean; }

export const HostGrantsGrantOutputSchema = z.object({ created: z.boolean() });
export const HostGrantsListOutputSchema = z.object({
  hosts: z.array(z.object({ host: z.string(), grantedAt: z.string() })),
});
export const HostGrantsRevokeOutputSchema = z.object({ revoked: z.boolean() });
```

- [ ] **Step 4: Implement the plugin**

`packages/host-grants/src/plugin.ts`:

```typescript
import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runHostGrantsMigration, type HostGrantsDatabase } from './migrations.js';
import { createHostGrantsStore, type HostGrantsStore } from './store.js';
import {
  HostGrantsGrantOutputSchema, HostGrantsListOutputSchema, HostGrantsRevokeOutputSchema,
  type HostGrantsGrantInput, type HostGrantsGrantOutput,
  type HostGrantsListInput, type HostGrantsListOutput,
  type HostGrantsRevokeInput, type HostGrantsRevokeOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/host-grants';

function requireField(value: string | undefined, name: string): string {
  if (!value) {
    throw new PluginError({ code: 'missing-field', plugin: PLUGIN_NAME, message: `${name} is required` });
  }
  return value;
}

export function createHostGrantsPlugin(): Plugin {
  let store: HostGrantsStore | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['host-grants:grant', 'host-grants:list', 'host-grants:revoke'],
      calls: ['database:get-instance'],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db } = await bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', initCtx, {});
      const typed = db as Kysely<HostGrantsDatabase>;
      await runHostGrantsMigration(typed);
      store = createHostGrantsStore(typed);

      bus.registerService<HostGrantsGrantInput, HostGrantsGrantOutput>(
        'host-grants:grant', PLUGIN_NAME,
        async (_ctx, input) =>
          store!.grant({
            ownerUserId: requireField(input.ownerUserId, 'ownerUserId'),
            agentId: requireField(input.agentId, 'agentId'),
            host: input.host,
          }),
        { returns: HostGrantsGrantOutputSchema },
      );

      bus.registerService<HostGrantsListInput, HostGrantsListOutput>(
        'host-grants:list', PLUGIN_NAME,
        async (_ctx, input) => ({
          hosts: await store!.list(requireField(input.ownerUserId, 'ownerUserId'), requireField(input.agentId, 'agentId')),
        }),
        { returns: HostGrantsListOutputSchema },
      );

      bus.registerService<HostGrantsRevokeInput, HostGrantsRevokeOutput>(
        'host-grants:revoke', PLUGIN_NAME,
        async (_ctx, input) =>
          store!.revoke({
            ownerUserId: requireField(input.ownerUserId, 'ownerUserId'),
            agentId: requireField(input.agentId, 'agentId'),
            host: input.host,
          }),
        { returns: HostGrantsRevokeOutputSchema },
      );
    },
  };
}
```

(The kysely `Kysely` type comes from the `kysely` package, not `@ax/core` — `@ax/core` exports only the hook-bus / plugin / context types.)

Extend `packages/host-grants/src/index.ts`:

```typescript
export { runHostGrantsMigration, type HostGrantsDatabase, type HostGrantRow } from './migrations.js';
export { createHostGrantsPlugin } from './plugin.js';
export type {
  HostGrantsGrantInput, HostGrantsGrantOutput,
  HostGrantsListInput, HostGrantsListOutput,
  HostGrantsRevokeInput, HostGrantsRevokeOutput,
} from './types.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/host-grants test`
Expected: PASS (whole package green).

- [ ] **Step 6: Commit**

```bash
git add packages/host-grants/src/types.ts packages/host-grants/src/plugin.ts packages/host-grants/src/index.ts packages/host-grants/src/__tests__/plugin.test.ts
git commit -m "feat(host-grants): host-grants:grant/list/revoke service hooks"
```

---

### Task 4: `proxy:add-host` returns the session's `agentId` (authoritative grant key)

**Files:**
- Modify: `packages/credential-proxy/src/listener.ts`, `packages/credential-proxy/src/plugin.ts`
- Test: `packages/credential-proxy/src/__tests__/plugin.test.ts`

> **Boundary review** (extends TASK-37's `proxy:add-host`): input `{ sessionId, host }` is unchanged; output gains `agentId?: string` (present iff `added`). `agentId` is a domain id the proxy already accepts at open-session — no backend vocabulary, no leak. Single-impl service hook (no subscriber risk). **Still host-internal — not an IPC action** (TASK-37 fork #1 stands). The proxy remains the single source of truth for session→`(user, agent)` (I4). `returns` schema updates to `z.object({ added: z.boolean(), agentId: z.string().optional() })`.

- [ ] **Step 1: Write the failing test**

In `packages/credential-proxy/src/__tests__/plugin.test.ts`, add (alongside the existing `proxy:add-host` describe block — mirror its `bootProxyPlugin()` / `ctx({ userId })` helpers):

```typescript
it('proxy:add-host returns the session agentId on a successful grant', async () => {
  const { bus } = await bootProxyPlugin();
  await bus.call('proxy:open-session', ctx({ userId: 'u1' }), {
    sessionId: 's1', userId: 'u1', agentId: 'agent-7', allowlist: ['a.example.com'], credentials: {},
  });
  const out = await bus.call('proxy:add-host', ctx({ userId: 'u1' }), { sessionId: 's1', host: 'b.example.com' });
  expect(out).toEqual({ added: true, agentId: 'agent-7' });
});

it('proxy:add-host returns { added:false } (no agentId) for an unknown session', async () => {
  const { bus } = await bootProxyPlugin();
  const out = await bus.call('proxy:add-host', ctx({ userId: 'u1' }), { sessionId: 'gone', host: 'b.example.com' });
  expect(out).toEqual({ added: false });
});
```

Also **update** the existing TASK-37 assertion `expect(out).toEqual({ added: true })` for the owner-grant case to `expect(out).toEqual({ added: true, agentId: <the agentId that test opened the session with> })` (match the `agentId` passed to that test's `proxy:open-session`). The unknown/closed and ownership/invalid-host cases keep their existing assertions (unknown stays `{ added: false }`; throws are unchanged).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/plugin.test.ts`
Expected: FAIL — `agentId` is `undefined` on the success result.

- [ ] **Step 3: Store `agentId` on the session + return it**

In `packages/credential-proxy/src/listener.ts`, add to `SessionConfig` (next to `userId`, ≈94):

```typescript
  /**
   * The agent this session was opened for. The plugin sets it on open-session;
   * proxy:add-host returns it so a host-side caller can persist a per-(user,
   * agent) "always-allow" grant (TASK-44) without trusting a browser-supplied
   * agentId. Optional for back-compat with SessionConfigs tests build directly.
   */
  agentId?: string;
```

In `packages/credential-proxy/src/plugin.ts`, in the `proxy:open-session` handler where the new `SessionConfig` is built (the `sessions.set(...)` near ≈420-430, which already sets `userId`/`sessionId`), add `agentId: input.agentId,` to the stored config.

Then update the `proxy:add-host` handler (≈559-595) return + its `AddHostOutput` type (≈244):

```typescript
interface AddHostOutput {
  added: boolean;
  /** The session's agentId — present iff added. Authoritative grant key for TASK-44. */
  agentId?: string;
}
```

```typescript
          const sess = sessions.get(sessionId);
          if (sess === undefined) return { added: false }; // closed/unknown — graceful no-op
          if (sess.userId === undefined || sess.userId !== ctx.userId) {
            throw new PluginError({ code: 'forbidden', plugin: PLUGIN_NAME, message: 'caller is not the session owner' });
          }
          sess.allowlist.add(host);
          return { added: true, agentId: sess.agentId };
```

If the hook registration declares a `returns` schema, update it to `z.object({ added: z.boolean(), agentId: z.string().optional() })` (if TASK-37 registered `proxy:add-host` without a `returns` schema, leave it — adding one is optional and out of scope here).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/credential-proxy test`
Expected: PASS (whole package green — confirm the canary, Step below, and the rest stay green).

- [ ] **Step 5: Update the reactive-wall canary assertion**

In `packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts`, the live-grant assertion `expect(await bus.call('proxy:add-host', ...)).toEqual({ added: true })` becomes `expect(await bus.call('proxy:add-host', ...)).toEqual({ added: true, agentId: 'a1' })` (the canary opens its session with `agentId: 'a1'` — match the literal that test used).

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/reactive-wall.canary.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/credential-proxy/src/listener.ts packages/credential-proxy/src/plugin.ts packages/credential-proxy/src/__tests__/plugin.test.ts packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts
git commit -m "feat(credential-proxy): proxy:add-host returns the session agentId (authoritative grant key)"
```

---

### Task 5: Orchestrator loads persisted host grants into the allowlist at session open

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

> **Boundary review:** the orchestrator only *calls* `host-grants:list` (read), gated by `bus.hasService` and **not declared in the manifest** — the same convention the file documents for `skills:list-user-attachments` / `skills:resolve` / `skills:list-defaults` (conditionally called; stripped presets without `@ax/host-grants` no-op). No new subscriber, no new IPC. The call is **credential-free** (hosts only), so a throw **fails open** (log + treat as empty) — distinct from the credential-bearing `skills:list-user-attachments` which fails closed. Failing open here is safe: an empty result yields *fewer* allowlist hosts (the user just re-hits the wall and re-grants), never *more* — it can never widen egress.

- [ ] **Step 1: Write the failing test**

In `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`, extend the proxy-lifecycle suite (the block that registers a capturing `proxy:open-session` ≈1135 and asserts its `allowlist` payload ≈1221-1226). Add:

```typescript
it('unions persisted host grants into the proxy:open-session allowlist', async () => {
  const mocks = makeMocks(); // the file's helper that builds the service map + capture
  mocks.services['host-grants:list'] = async (_ctx, input: unknown) => {
    expect((input as { agentId: string }).agentId).toBeTruthy(); // keyed by (user, agent)
    return { hosts: [{ host: 'persisted.example.com', grantedAt: new Date().toISOString() }] };
  };
  let capturedAllowlist: string[] = [];
  mocks.services['proxy:open-session'] = async (_ctx, input: unknown) => {
    capturedAllowlist = (input as { allowlist: string[] }).allowlist;
    return mocks.proxyOpenResult; // the file's canonical proxy-open output
  };
  await runInvokeToOpenSession(mocks); // the file's helper that drives agent:invoke to the open-session call
  expect(capturedAllowlist).toContain('persisted.example.com');
});

it('fails OPEN when host-grants:list throws — session still opens, host absent', async () => {
  const mocks = makeMocks();
  mocks.services['host-grants:list'] = async () => { throw new Error('db down'); };
  let capturedAllowlist: string[] = [];
  let opened = false;
  mocks.services['proxy:open-session'] = async (_ctx, input: unknown) => {
    capturedAllowlist = (input as { allowlist: string[] }).allowlist;
    opened = true;
    return mocks.proxyOpenResult;
  };
  await runInvokeToOpenSession(mocks);
  expect(opened).toBe(true); // not terminated
  expect(capturedAllowlist).not.toContain('persisted.example.com');
});
```

(Use the file's existing helpers — the proxy-lifecycle tests already register a capturing `proxy:open-session` and assert `input.allowlist`; reuse that exact seam. If the file has no `makeMocks`/`runInvokeToOpenSession` by those names, mirror the closest existing proxy-lifecycle test's setup verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test -- src/__tests__/orchestrator.test.ts`
Expected: FAIL — `persisted.example.com` not in the captured allowlist.

- [ ] **Step 3: Add the union block**

In `packages/chat-orchestrator/src/orchestrator.ts`, immediately before `const unionedAllowlist = [...baseAllowSet];` (≈1353), add:

```typescript
    // TASK-44 — persistent per-(user, agent) host grants ("always allow", design
    // §6B / §P7.3 / decision #12). The durable twin of the LIVE proxy:add-host
    // grant (TASK-37): hosts the user previously chose "Always for this agent"
    // for are loaded into THIS session's egress allowlist at open. Gated by
    // hasService (conditionally called, NOT declared in the manifest — same
    // convention as skills:list-user-attachments above): stripped presets without
    // @ax/host-grants no-op. CREDENTIAL-FREE (hosts only), so a throw FAILS OPEN
    // (log + empty) — an empty result yields FEWER hosts (user re-hits the wall),
    // never more, so it can't widen egress.
    if (bus.hasService('host-grants:list')) {
      try {
        const r = await bus.call<
          { ownerUserId: string; agentId: string },
          { hosts: Array<{ host: string; grantedAt: string }> }
        >('host-grants:list', ctx, { ownerUserId: ctx.userId, agentId: agent.id });
        for (const g of r.hosts) baseAllowSet.add(g.host);
      } catch (err) {
        ctx.logger.warn('host_grants_list_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
```

(No manifest change to `packages/chat-orchestrator/src/plugin.ts` — matches the orchestrator's established conditionally-called convention.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): load persisted per-(user,agent) host grants into the session allowlist"
```

---

### Task 6: Grant route persists on `persist:true` via `host-grants:grant`

**Files:**
- Modify: `packages/channel-web/src/server/routes-allow-host.ts`, `packages/channel-web/src/server/plugin.ts`
- Test: `packages/channel-web/src/__tests__/server/routes-allow-host.test.ts`

> **Boundary review** (the route is host-internal plumbing, not a new hook): when `persist` is set, after the live `proxy:add-host` succeeds the route calls `host-grants:grant` with `{ ownerUserId: <authed userId>, agentId: <returned by proxy:add-host>, host }`. The grant key is fully server-authoritative — `userId` from auth, `agentId` from the proxy (fork #2). The call is `hasService`-guarded and declared in channel-web's `optionalCalls` with a degradation note (the "Always" button still does the live grant if `@ax/host-grants` is absent). CSRF + auth unchanged from TASK-37.

- [ ] **Step 1: Write the failing test**

In `packages/channel-web/src/__tests__/server/routes-allow-host.test.ts`, add (mirror the existing TASK-37 setup — `makeBus()`, `bus.registerService('auth:require-user', ...)`, `bus.registerService('proxy:add-host', ...)`, `makeAllowHostHandler`, `fakeReq`/`fakeRes`):

```typescript
it('persist:true → calls host-grants:grant with the authed userId + proxy-returned agentId', async () => {
  const grants: unknown[] = [];
  const bus = makeBus();
  bus.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u1', isAdmin: false } }));
  bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
  bus.registerService('host-grants:grant', 'hg', async (_ctx, input) => { grants.push(input); return { created: true }; });
  const handler = makeAllowHostHandler({ bus, initCtx });

  const res = fakeRes();
  await handler(fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com', persist: true })) }), res);
  expect(res.statusCode).toBe(200);
  expect(grants).toEqual([{ ownerUserId: 'u1', agentId: 'agent-7', host: 'x.example.com' }]);
});

it('persist omitted/false → does NOT persist (live grant only, TASK-37 behavior preserved)', async () => {
  const grants: unknown[] = [];
  const bus = makeBus();
  bus.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u1', isAdmin: false } }));
  bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
  bus.registerService('host-grants:grant', 'hg', async (_ctx, input) => { grants.push(input); return { created: true }; });
  const handler = makeAllowHostHandler({ bus, initCtx });
  const res = fakeRes();
  await handler(fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com' })) }), res);
  expect(res.statusCode).toBe(200);
  expect(grants).toEqual([]);
});

it('persist:true still returns 200 when @ax/host-grants is absent (degrades — no persistence)', async () => {
  const bus = makeBus();
  bus.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u1', isAdmin: false } }));
  bus.registerService('proxy:add-host', 'proxy', async () => ({ added: true, agentId: 'agent-7' }));
  // no host-grants:grant registered
  const handler = makeAllowHostHandler({ bus, initCtx });
  const res = fakeRes();
  await handler(fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'x.example.com', persist: true })) }), res);
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-allow-host.test.ts`
Expected: FAIL — `persist` ignored; `host-grants:grant` never called.

- [ ] **Step 3: Implement the persist branch**

In `packages/channel-web/src/server/routes-allow-host.ts`, widen `BodySchema` and the `AddHostOutput` type, and add the persist call after the live grant:

```typescript
const BodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
  // "Always for this agent" → persist a durable per-(user, agent) grant in
  // addition to the live widen. Default false = TASK-37 "just this once".
  persist: z.boolean().optional().default(false),
});

interface AddHostOutput {
  added: boolean;
  agentId?: string;
}

interface HostGrantsGrantInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
```

Replace the `proxy:add-host` call + response with:

```typescript
    try {
      const out = await deps.bus.call<AddHostInput, AddHostOutput>('proxy:add-host', ctx, {
        sessionId: body.sessionId,
        host: body.host,
      });

      // "Always for this agent": durably persist the grant so future sessions
      // load it (TASK-44). The grant key is server-authoritative — userId from
      // auth (above), agentId from the proxy's own SessionConfig (returned by
      // proxy:add-host). The browser supplied neither. Guarded by hasService so
      // a preset without @ax/host-grants degrades to live-only.
      if (body.persist && out.added && out.agentId !== undefined && deps.bus.hasService('host-grants:grant')) {
        await deps.bus.call<HostGrantsGrantInput, { created: boolean }>('host-grants:grant', ctx, {
          ownerUserId: userId,
          agentId: out.agentId,
          host: body.host,
        });
      }

      res.status(200).json({ added: out.added });
    } catch (err) {
      if (err instanceof PluginError && err.code === 'forbidden') { res.status(403).json({ error: 'forbidden' }); return; }
      if (err instanceof PluginError && err.code === 'invalid-host') { res.status(400).json({ error: 'invalid-host' }); return; }
      throw err;
    }
```

In `packages/channel-web/src/server/plugin.ts`, add an `optionalCalls` entry to the manifest (the manifest currently has only `registers`/`calls`/`subscribes` — add the `optionalCalls` field):

```typescript
      optionalCalls: [
        {
          hook: 'host-grants:grant',
          degradation:
            'the reactive-wall "Always for this agent" button persists nothing across sessions; the live proxy:add-host grant still applies for the current session',
        },
      ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-allow-host.test.ts`
Expected: PASS (including TASK-37's existing route tests — the `{ added }` response shape is preserved).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/routes-allow-host.ts packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/routes-allow-host.test.ts
git commit -m "feat(channel-web): allow-host route persists on persist:true via host-grants:grant"
```

---

### Task 7: Card "Always for this agent" sends `persist:true`

**Files:**
- Modify: `packages/channel-web/src/lib/credentials.ts`, `packages/channel-web/src/components/PermissionCard.tsx`
- Test: `packages/channel-web/src/__tests__/permission-card.test.tsx`

> Invoke the **`shadcn`** skill first (invariant #6) before touching `PermissionCard.tsx`. This task only changes button click handlers + adds an optional fetch field — no new primitives — but confirm no raw colors / hand-rolled forms creep in.

- [ ] **Step 1: Write the failing test**

In `packages/channel-web/src/__tests__/permission-card.test.tsx`, **update** TASK-37's "Always for this agent" test (it currently just asserts a POST happens) so it asserts the persist flag, and keep "Just this once" asserting no persist:

```typescript
it('"Always for this agent" POSTs persist:true', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ added: true }), { status: 200 }));
  render(<PermissionCard />);
  permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
  fireEvent.click(await screen.findByRole('button', { name: /always for this agent/i }));
  await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
  expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"persist":true');
});

it('"Just this once" POSTs without persist:true', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ added: true }), { status: 200 }));
  render(<PermissionCard />);
  permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
  fireEvent.click(await screen.findByRole('button', { name: /just this once/i }));
  await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
  expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain('"persist":true');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: FAIL — both buttons currently POST identical bodies (no `persist`).

- [ ] **Step 3: Thread `persist` through `grantHost` + the card**

In `packages/channel-web/src/lib/credentials.ts`, widen `grantHost`:

```typescript
export async function grantHost(input: {
  sessionId: string;
  host: string;
  /** "Always for this agent" → durably persist a per-(user, agent) grant (TASK-44). */
  persist?: boolean;
}): Promise<void> {
  const res = await fetch('/api/chat/allow-host', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`allow-host failed: ${res.status}`);
}
```

In `packages/channel-web/src/components/PermissionCard.tsx`, give `allow` a `persist` parameter and wire the two buttons:

```tsx
  async function allow(persist: boolean): Promise<void> {
    if (busy || request === null || request.kind !== 'host') return;
    setBusy(true);
    setError(null);
    try {
      await grantHost({ sessionId: request.sessionId, host: request.host, persist });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
```

Replace the two host-branch buttons (the existing `() => void allow()` pair) with:

```tsx
          <Button variant="outline" disabled={busy} onClick={() => void allow(true)}>
            Always for this agent
          </Button>
          <Button disabled={busy} onClick={() => void allow(false)}>
            {busy ? 'Allowing…' : 'Just this once'}
          </Button>
```

(Delete the stale TASK-37 comment "`Always` does the same LIVE grant this phase; per-(user, agent) persistence is TASK-44." — it's now done.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: PASS (skill + host variants green).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/credentials.ts packages/channel-web/src/components/PermissionCard.tsx packages/channel-web/src/__tests__/permission-card.test.tsx
git commit -m "feat(channel-web): 'Always for this agent' sends persist:true to the grant route"
```

---

### Task 8: Wire `@ax/host-grants` into the k8s preset

**Files:**
- Modify: `presets/k8s/src/index.ts`, `presets/k8s/package.json`
- Test: `presets/k8s/src/__tests__/preset.test.ts`

> Invariant #3 (no half-wired plugins): the plugin must be registered + reachable. After this task it is wired into the production assembly alongside `@ax/skills`/`@ax/agents`; its `grant`/`list` hooks have live callers (route + orchestrator) and the canary (Task 9) exercises all three.

- [ ] **Step 1: Write the failing test**

In `presets/k8s/src/__tests__/preset.test.ts`, extend the boot/manifest assertion (the test that builds `createK8sPlugins(cfg)` and inspects the returned plugin list / collected `registers`). Add:

```typescript
it('loads @ax/host-grants and registers host-grants:grant/list/revoke', () => {
  const plugins = createK8sPlugins(testConfig()); // the file's existing config helper
  const hg = plugins.find((p) => p.manifest.name === '@ax/host-grants');
  expect(hg).toBeDefined();
  expect(hg!.manifest.registers).toEqual(['host-grants:grant', 'host-grants:list', 'host-grants:revoke']);
});
```

(If `preset.test.ts` asserts a complete set of registered hooks across the assembly, add the three `host-grants:*` hooks to that expected set too.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: FAIL — no `@ax/host-grants` plugin in the list.

- [ ] **Step 3: Wire the plugin + dependency**

In `presets/k8s/package.json`, add to `dependencies` (keep the list alphabetized):

```json
    "@ax/host-grants": "workspace:*",
```

In `presets/k8s/src/index.ts`, add the import (near the other `@ax/*` imports):

```typescript
import { createHostGrantsPlugin } from '@ax/host-grants';
```

And push it in the section-8 area, right after `@ax/skill-broker` (≈728), so it sits with the JIT skills/grant plugins:

```typescript
  // ----- 8a''. host grants ----------------------------------------------
  // @ax/host-grants — the persistent per-(user, agent) "always-allow" egress
  // host store (JIT design §6B / §P7.3 / decision #12, TASK-44). The durable
  // twin of the LIVE proxy:add-host grant (TASK-37): the chat-orchestrator
  // loads these hosts into the egress allowlist at session open (hasService-
  // gated), and the channel-web allow-host route writes one when the user
  // clicks "Always for this agent". Reuses the shared postgres pool via
  // database:get-instance. host-grants:revoke's settings-UI caller lands in
  // TASK-42 (half-wired window OPEN until then; reachable + tested via the
  // package canary here).
  plugins.push(createHostGrantsPlugin());
```

Run `pnpm install` so the preset resolves the new workspace dep.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/package.json presets/k8s/src/__tests__/preset.test.ts pnpm-lock.yaml
git commit -m "feat(preset-k8s): wire @ax/host-grants into the production assembly"
```

---

### Task 9: Canary + full verification + security-checklist + PR

**Files:**
- Create: `packages/host-grants/src/__tests__/host-grants.canary.test.ts`
- Create: `.changeset/jit-host-grants-store.md`

- [ ] **Step 1: Write the canary (grant → list → revoke, all three hooks reachable)**

`packages/host-grants/src/__tests__/host-grants.canary.test.ts` — boot the real plugin over a bus harness + real postgres (testcontainers), proving the full surface end to end (this is the invariant-#3 reachability artifact that also covers the half-wired `revoke`):

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createHostGrantsPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
async function boot() {
  const h = await createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString }), createHostGrantsPlugin()] });
  harnesses.push(h);
  return h;
}
beforeAll(async () => { container = await new PostgreSqlContainer('postgres:16-alpine').start(); connectionString = container.getConnectionUri(); }, 120_000);
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString }); await c.connect();
  try { await c.query('DROP TABLE IF EXISTS host_grants_v1_grants'); } finally { await c.end().catch(() => {}); }
});
afterAll(async () => { if (container) await container.stop(); });

describe('host-grants canary', () => {
  it('grant → list → revoke is durable and (user, agent)-scoped', async () => {
    const h = await boot();
    await h.bus.call('host-grants:grant', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: 'status.example.com' });
    await h.bus.call('host-grants:grant', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: 'api.linear.app' });
    // Another agent / another user never see u1/a1's grants.
    await h.bus.call('host-grants:grant', h.ctx(), { ownerUserId: 'u1', agentId: 'a2', host: 'other.example.com' });

    const listed = await h.bus.call('host-grants:list', h.ctx(), { ownerUserId: 'u1', agentId: 'a1' });
    expect((listed as { hosts: { host: string }[] }).hosts.map((x) => x.host)).toEqual(['api.linear.app', 'status.example.com']);

    expect(await h.bus.call('host-grants:revoke', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: 'api.linear.app' })).toEqual({ revoked: true });
    expect((await h.bus.call('host-grants:list', h.ctx(), { ownerUserId: 'u1', agentId: 'a1' }) as { hosts: { host: string }[] }).hosts.map((x) => x.host)).toEqual(['status.example.com']);

    // A bad host never lands.
    await expect(h.bus.call('host-grants:grant', h.ctx(), { ownerUserId: 'u1', agentId: 'a1', host: '*.evil.com' })).rejects.toThrow(/invalid host/i);
  });
});
```

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/host-grants test -- src/__tests__/host-grants.canary.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the changeset**

`.changeset/jit-host-grants-store.md`:

```markdown
---
'@ax/host-grants': minor
'@ax/credential-proxy': patch
'@ax/chat-orchestrator': patch
'@ax/channel-web': patch
'@ax/preset-k8s': patch
---

JIT: persistent per-(user, agent) host-grant store ("always allow"). New `@ax/host-grants` plugin (`host-grants:grant`/`list`/`revoke`) persists the reactive egress wall's "Always for this agent" choice; the orchestrator loads grants into the allowlist at session open; `proxy:add-host` now returns the session agentId so the grant key stays server-authoritative. Closes TASK-37's half-wired persistence window. (TASK-44)
```

- [ ] **Step 4: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc project refs) catches a missing root `references` entry or a workspace dep the new package didn't declare; `pnpm lint` catches an accidental cross-plugin import (`no-restricted-imports`) — confirm the orchestrator + route use **local** types for `host-grants:*`/`proxy:add-host`, never an `@ax/host-grants` / `@ax/credential-proxy` runtime import — and a raw color / non-shadcn primitive in `PermissionCard.tsx`. Per repo convention. Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 5: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated). Key items: (a) persisted grants auto-widen *future* sessions — confirm the load path can only *narrow* on failure (fail-open → fewer hosts) and that hosts are exact-match re-validated at the `@ax/host-grants` write boundary; (b) the grant key is server-authoritative (`userId` from auth, `agentId` from the proxy) — confirm no browser-supplied value reaches the persist key; (c) `host-grants:*` are host-internal (no IPC), so the untrusted runner can't self-grant; (d) no new third-party dependency. Paste the structured note into the PR.

- [ ] **Step 6: Commit + open the PR**

```bash
git add packages/host-grants/src/__tests__/host-grants.canary.test.ts .changeset/jit-host-grants-store.md
git commit -m "test(host-grants): canary (grant → list → revoke, (user,agent)-scoped)"
```

PR description MUST include:
- **Boundary review** — the three new `host-grants:*` hooks (`{ ownerUserId, agentId, host }` in; `{ created }`/`{ hosts: { host, grantedAt }[] }`/`{ revoked }` out; alternate impl = JSON column / generic KV store / non-SQL backend; no leak; subscriber risk none; host-internal — not IPC). The `proxy:add-host` return change `{ added }` → `{ added, agentId? }` (`agentId` is a domain id; still host-internal; single-impl).
- **Half-wired window OPEN** (see below).
- The `security-checklist` structured note.

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 9 Step 5). This work touches the **egress trust boundary from persisted state** — the flagged threat (design §10). Starting model:

- **Persistent egress widening (the flagged threat).** A persisted grant auto-widens *future* sessions' allowlists at open. Contained by: (1) the grant is keyed by an **authoritative `userId`** (the auth cookie at the write route), so a grant only ever widens *that user's own* isolated sandboxes — no cross-user reach; (2) the host is **exact-match re-validated** (`HOST_RE`) at the `@ax/host-grants` write boundary, independent of the proxy's validator (I2) — no wildcards/ports/schemes/blanket egress; (3) a **per-(user,agent) cap** (256) bounds growth; (4) the **only writer** is the CSRF-gated, authenticated `allow-host` route, invoked after the user clicked "Always" on a card showing the exact host — the untrusted runner can never write (the hooks are host-internal, not IPC actions); (5) the load path **fails open-safe**: a `host-grants:list` failure yields *fewer* allowlist hosts (the user re-hits the wall and re-grants), never *more*.
- **Grant-key integrity.** `userId` is authoritative (auth). `agentId` is derived from the **proxy's own `SessionConfig`** (returned by `proxy:add-host` after its `userId === ctx.userId` ownership check) — the browser supplies neither half of the key, only the opaque `sessionId` (re-validated by the proxy) and a `persist` flag. A forged/guessed `sessionId` for another user's session is already rejected (`forbidden`, TASK-37), so the persist path inherits that isolation.
- **Prompt injection steering a grant.** Injection can make the agent *attempt* a host (raising the card), but persistence requires the **user** to click "Always for this agent" on a card showing the exact hostname (the §10 card-as-backstop). The agent cannot self-persist — `host-grants:*` are host-internal, and `proxy:add-host` is too.
- **Sandbox / capability leakage.** No new IPC action (the agent→host wire surface is unchanged). No new filesystem/process/env reach. The orchestrator load is host-side and read-only; the host string renders nowhere new (it already rendered on the TASK-37 card as an auto-escaped React text node).
- **Supply chain.** No new third-party dependency — `@ax/host-grants` uses only `kysely` + `zod` + `@ax/core`, all already in the tree. Confirm `pnpm-lock.yaml` shows no new registry packages.

---

## Half-wired window

Stated explicitly per hard requirement #5:

1. **`host-grants:revoke` has no production UI caller yet.** The settings "Allowed sites (this agent) → Revoke" control (design §P3/§P6, the out-of-band mirror) is **TASK-42**. The hook is fully built, reachable, and tested here (the plugin test + the canary's `grant → list → revoke` roundtrip), so the *plugin* is not half-wired — `host-grants:grant` (allow-host route) and `host-grants:list` (orchestrator session-open) both have live production callers. Only `revoke`'s settings consumer is deferred. **CLOSES in TASK-42.**
2. **`host-grants:list` has a live caller but its settings *view* is deferred.** The orchestrator consumes it at session open (live); the settings "Allowed sites" list that renders it for management is also TASK-42. `list` is therefore **not** half-wired — only its second (UI) consumer lands later.
3. **A prior window CLOSES here:** TASK-37's half-wired window #1 ("Always for this agent" did only a live grant, no persistence). After this card, "Always" persists via `host-grants:grant` and the orchestrator reloads it on the next fresh spawn — the button is now durable, as designed (§6B). (TASK-37's window #2, seamless auto-retry, is unrelated and remains owned by TASK-36.)

---

## Self-Review

**Spec coverage** (against design §6B flow B, §P7.3 build addition #3, decision #12, §10 security, §P6 mirror property, and the card body):

- "Per-(user, agent) host-grant store (the persistent 'always-allow' list)" → Tasks 1-3 (`@ax/host-grants`: table + store + hooks). ✓
- "loaded into the allowlist at session open" → Task 5 (orchestrator unions `host-grants:list` into the `proxy:open-session` allowlist, fresh-spawn path). ✓
- "+ a revoke path" → `host-grants:revoke` (Task 3), tested via the canary (Task 9); settings UI caller = TASK-42 (stated half-wired). ✓
- "The 'Always for this agent' branch of the reactive wall (§6B) persists here" → Tasks 6-7 (route `persist` branch → `host-grants:grant`; card button → `persist:true`). Closes TASK-37 window #1. ✓
- "complements the live `proxy:add-host` (TASK-37)" → the live grant still fires for the current session; persistence is additive (Task 6 keeps the `{ added }` response + live widen). ✓
- "Depends on TASK-37" → merged; the re-verify checklist confirms the as-built reactive-wall surface. ✓
- "revocable in settings (TASK-42)" → `host-grants:revoke` provided here for TASK-42 to call. ✓
- Decision #12 "host-grants per-(user, agent)" → compound PK `(owner_user_id, agent_id, host)`; the orchestrator keys the load on `(ctx.userId, agent.id)`. ✓
- §10 "capabilities minimized … never blanket egress" → exact-match host validation + per-(user,agent) cap + server-authoritative grant key + host-internal (non-IPC) hooks. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. Harness-bound steps (the orchestrator `makeMocks`/`runInvokeToOpenSession` proxy-lifecycle seam, the route `makeBus`/`fakeReq`/`fakeRes`, the card `permissionCardActions`/`getPermissionCardSnapshot`, the proxy `bootProxyPlugin`/`ctx`) reference each file's existing helpers by name with concrete assertions — matching the template's harness-bound tasks. No TBD/TODO in shipped code. ✓

**Type consistency:** the grant key is `{ ownerUserId, agentId, host }` at every hop (`host-grants:grant` input, the route's `HostGrantsGrantInput`, the store). `host-grants:list` returns `{ hosts: { host, grantedAt }[] }` everywhere (plugin `returns` schema, orchestrator local type, store `HostGrant`). `proxy:add-host` is `{ sessionId, host }` → `{ added: boolean; agentId?: string }` at the hook, the proxy handler, and the route's local `AddHostOutput`. The browser-facing `PermissionRequest` host variant is **unchanged** (`{ kind:'host', host, sessionId }`) — `agentId` never reaches the client (fork #2); the route adds only an optional `persist` flag to the wire body. `grantHost`'s `persist?: boolean` matches the `BodySchema` `persist` default-false.

**Known residual / forks (resolved):** (1) the store lives in a **new `@ax/host-grants` plugin** (fork 1) — k8s-preset-only (DB-backed), no CLI-preset load (CLI uses sqlite + no DB-backed plugins, so `hasService('host-grants:list')` is false there and the orchestrator no-ops); (2) the grant `agentId` is **server-authoritative via the proxy** (fork 2), not browser-supplied; (3) "Always" persists at click time — if the live session has already ended (`proxy:add-host` → `{ added:false }`, no `agentId`), persistence is skipped (rare; the live grant also fails in that case, and the user can re-grant next turn) — acceptable; (4) persisted grants load on **fresh spawn** (the orchestrator's `proxy:open-session` path); a kept-alive session already has the host live (TASK-37), and the persisted grant covers the *next* fresh spawn — matches design §7 (host-grant = no re-spawn).
