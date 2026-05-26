# Week 7–9: k8s deployment shape — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (via superpowers:subagent-driven-development) to implement this plan task-by-task. Fresh subagent per task, code review between tasks.

**Goal:** Swap the single-host plugins shipped in Week 4–6 for their production-shape equivalents so v2 can deploy to, and run a real chat on, a real k8s cluster without changing any subscriber code.

**Architecture:** Invariant 1 (transport/storage-agnostic hooks) says a Week 4–6 subscriber must continue to work unchanged when a postgres / k8s / git-backed plugin replaces its sqlite / subprocess / in-memory counterpart. This slice validates that claim by shipping the production impls behind the same hook surfaces — and by introducing the workspace contract (Section 4.5) with *two* backends (git + a test MockWorkspace) so the contract is never validated against only one implementation.

**Tech Stack:** Kysely + `pg` driver, `@kubernetes/client-node`, `isomorphic-git` or `simple-git` (decide in Task 8), LISTEN/NOTIFY over pg, testcontainers for CI, kind for local k8s verification.

**Branch:** `feat/week-7-9-k8s-deployment`, branched off `main` at `6ff8ec8` (tip of Week 4–6 plus the llm-anthropic error-surface fix).

---

## Preconditions (verify before Task 1)

Run once, at the top of the first subagent:

```bash
git rev-parse HEAD                        # must be 6ff8ec8 (or a descendant)
pnpm build && pnpm test                   # baseline must be green
ls packages/                              # sandbox-subprocess, storage-sqlite, llm-anthropic present
grep -n "WorkspaceVersion" packages/core/src/*.ts || echo "no workspace contract yet — expected"
```

If the baseline is red, STOP and surface to the user — do not layer work on a broken tree.

Create the worktree / branch:

```bash
git checkout -b feat/week-7-9-k8s-deployment
```

---

## Slice map (subagent-driven order)

Tasks are grouped into four phases. Within a phase, later tasks depend on earlier ones; between phases, commit + code-review checkpoint.

| Phase | Tasks | Produces |
|---|---|---|
| A. Contracts | 1–4 | `@ax/core` workspace types, `@ax/eventbus-inprocess`, `MockWorkspace` in test-harness, contract test-suite |
| B. Workspace backend | 5–7 | `@ax/workspace-git` passing the shared contract suite |
| C. Postgres plugins | 8–12 | `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/eventbus-postgres`, `@ax/session-postgres` |
| D. k8s + preset + acceptance | 13–17 | `@ax/sandbox-k8s`, `@ax/preset-k8s`, deploy manifests, end-to-end acceptance |

**Security gate:** every new package must pass `security-checklist` before Phase D's acceptance task. Do NOT defer to the end.

---

## Phase A — Contracts (gets Section 4.5 right *before* we write the git impl)

### Task 1 — Workspace contract types in `@ax/core`

The whole point of Section 4.5 is that the types outlive any one backend. Land them in core so nothing is tempted to reach into `@ax/workspace-git` for a shared type.

**Files:**
- Create: `packages/core/src/workspace.ts`
- Modify: `packages/core/src/index.ts` — re-export the new symbols
- Test: `packages/core/src/__tests__/workspace.test.ts`

**Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/workspace.test.ts
import { describe, it, expect } from 'vitest';
import type { WorkspaceVersion, FileChange, WorkspaceDelta } from '../workspace.js';
import { asWorkspaceVersion } from '../workspace.js';

describe('workspace contract', () => {
  it('brands WorkspaceVersion so raw strings cannot be assigned', () => {
    const v: WorkspaceVersion = asWorkspaceVersion('abc123');
    expect(v).toBe('abc123');
    // @ts-expect-error — raw string must not be assignable to WorkspaceVersion
    const bad: WorkspaceVersion = 'plain';
    void bad;
  });

  it('FileChange tags `put` and `delete` variants only', () => {
    const put: FileChange = { path: 'a', kind: 'put', content: new Uint8Array([1]) };
    const del: FileChange = { path: 'a', kind: 'delete' };
    expect(put.kind).toBe('put');
    expect(del.kind).toBe('delete');
  });

  it('WorkspaceDelta exposes lazy contentBefore/contentAfter fetchers', async () => {
    const d: WorkspaceDelta = {
      before: null,
      after: asWorkspaceVersion('v1'),
      changes: [{
        path: 'x',
        kind: 'added',
        contentAfter: async () => new Uint8Array([42]),
      }],
    };
    const bytes = await d.changes[0].contentAfter!();
    expect(bytes[0]).toBe(42);
  });
});
```

Run: `pnpm test --filter @ax/core -- workspace` → **FAIL** (file not present).

**Step 2: Implement**

```ts
// packages/core/src/workspace.ts
export type WorkspaceVersion = string & { readonly __brand: 'WorkspaceVersion' };

export const asWorkspaceVersion = (s: string): WorkspaceVersion =>
  s as WorkspaceVersion;

export type Bytes = Uint8Array;

export type FileChange =
  | { path: string; kind: 'put'; content: Bytes }
  | { path: string; kind: 'delete' };

export type WorkspaceChangeKind = 'added' | 'modified' | 'deleted';

export type WorkspaceDelta = {
  before: WorkspaceVersion | null;
  after: WorkspaceVersion;
  reason?: string;
  author?: { agentId?: string; userId?: string; sessionId?: string };
  changes: Array<{
    path: string;
    kind: WorkspaceChangeKind;
    contentBefore?: () => Promise<Bytes>;
    contentAfter?: () => Promise<Bytes>;
  }>;
};

export type WorkspaceApplyInput = {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason?: string;
};

export type WorkspaceApplyResult = {
  version: WorkspaceVersion;
  delta: WorkspaceDelta;
};
```

Export from `packages/core/src/index.ts`:

```ts
export * from './workspace.js';
```

**Step 3: Register hook *names* (strings only, no impl yet)**

Add to wherever core declares canonical hook identifiers (grep for an existing `'llm:call'` string literal to find it). Add:

```ts
// service hooks
'workspace:apply'  // (WorkspaceApplyInput) → WorkspaceApplyResult
'workspace:read'   // ({ path, version? }) → Bytes
'workspace:list'   // ({ version?, pathGlob? }) → string[]
'workspace:diff'   // ({ from, to }) → WorkspaceDelta
// subscriber hooks
'workspace:pre-apply'
'workspace:applied'
```

**Step 4: Verify**

Run: `pnpm test --filter @ax/core` → all green; `pnpm build` → green.

**Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): workspace contract types (Section 4.5)"
```

### Task 2 — `@ax/eventbus-inprocess`

Week 4–6 didn't need this; the contract only has one impl. We ship the in-process bus here so the postgres bus in Task 11 has a peer to match. **If Week 4–6 already shipped this, skip to Task 3 and note it in the commit log.**

**Files:**
- Create: `packages/eventbus-inprocess/{package.json, tsconfig.json, src/index.ts, src/plugin.ts, src/__tests__/plugin.test.ts}`

**Contract (document in header comment of `plugin.ts`):**

```ts
// eventbus:emit(ctx, { channel: string, payload: unknown }) → void
// eventbus:subscribe(ctx, { channel: string, handler: (payload) => Promise<void> }) → { unsubscribe: () => void }
```

Channel names: ASCII `[a-z0-9:_-]+` only. Payload: must round-trip through `JSON.stringify` (enforced at emit — throw `PluginError` if not). This matches what `@ax/eventbus-postgres` will be forced to accept later; staying JSON-clean in-process prevents silent drift.

**Failing test first:**
```ts
it('delivers emit to subscribers in registration order', async () => { /* ... */ });
it('unsubscribe stops delivery', async () => { /* ... */ });
it('rejects non-JSON-serializable payloads', async () => { /* ... */ });
it('isolates subscriber throws — other subscribers still fire', async () => { /* ... */ });
```

Implement minimally (a `Map<channel, Set<handler>>`). Each handler runs in its own `try/catch`; failures go to `ctx.logger.error('eventbus_handler_failed', { channel, err })` — never `console`.

Commit: `feat(eventbus-inprocess): in-process LISTEN/NOTIFY-compatible bus`.

### Task 3 — `MockWorkspace` test harness

This is what Section 4.5's "subscriber code is identical across backends" test actually needs. Implemented as a snapshot-in-a-Map — no git, no disk.

**Files:**
- Create: `packages/test-harness/src/mock-workspace.ts`
- Modify: `packages/test-harness/src/index.ts` — export it
- Test: `packages/test-harness/src/__tests__/mock-workspace.test.ts`

**Shape:** stores a map of `WorkspaceVersion → Map<path, bytes>`. Each `apply` clones the parent snapshot, applies `FileChange[]`, generates a new version (`mock-v${n++}`), records a delta, notifies subscribers. `diff` is straight set-diff; `read`/`list` are map lookups. Conflict on stale `parent` → throw `PluginError` with `code: 'workspace_conflict'`.

**Tests:**
- round-trip apply → read → diff
- conflict detection when `parent` is not current
- `contentAfter` is a *function*, not eager bytes
- `workspace:pre-apply` reject short-circuits (no version created)
- `workspace:applied` fires exactly once per successful apply

Commit: `feat(test-harness): MockWorkspace — in-memory backend for contract tests`.

### Task 4 — Shared workspace contract test-suite

This is the teeth of invariant 1 for this slice.

**Files:**
- Create: `packages/test-harness/src/workspace-contract-suite.ts`

**Export:** a function `runWorkspaceContractSuite(name: string, boot: () => Promise<HookBus>)` that calls `describe(name, …)` with the full battery of assertions. **The same function is invoked against `MockWorkspace` in Task 3's tests and against `@ax/workspace-git` in Task 7.** If a test passes for one and fails for the other, the contract is the thing that's wrong — not the backend.

**Assertions to include (non-exhaustive; add what surfaces during Task 3):**
- apply → `delta.after` is retrievable via `read`
- `list({ version })` returns only paths present at that version
- `diff(from, to)` is symmetric-consistent with the deltas emitted by intervening applies
- deleting then re-adding same path yields `kind: 'modified'` in a diff across both
- `contentBefore` on `added` is `undefined`; `contentAfter` on `deleted` is `undefined`
- no hook payload key is named `sha`, `commit`, `branch`, `ref`, or `bundle` (assert via `Object.keys` snapshot — make this an explicit test, not a style check)
- pre-apply rejection → no version change observed via subsequent `read`

Run the suite against `MockWorkspace` now; fix either the suite or the mock until green.

Commit: `test(test-harness): shared workspace contract suite`.

**Phase A checkpoint:** invoke `superpowers:requesting-code-review` against the diff so far. The contract must be right before Phase B pours a backend against it.

---

## Phase B — `@ax/workspace-git`

### Task 5 — Scaffold `@ax/workspace-git` + security-checklist

**Files:**
- Create: `packages/workspace-git/{package.json, tsconfig.json, src/index.ts, src/plugin.ts, src/__tests__/plugin.test.ts}`
- Modify: `pnpm-workspace.yaml` (already globs `packages/*` — no change needed; verify)

**Dependencies decision:** prefer `isomorphic-git` (pure JS, no native deps, runs in tests without a system git). Fall back to shelling out to `git` only if a specific op (atomic ref update) is infeasible — document the decision in the package README in one line.

**Before writing any code:** invoke `security-checklist` skill with scope "workspace-git". The key items this surfaces:
- **Path traversal:** all `FileChange.path` values MUST be normalized and rejected if they escape the repo root. Port `safePath` from `~/dev/ai/ax/` — do not reinvent.
- **Secret material in commit objects:** the `reason` string is agent-supplied; it lands in the commit message. Bound its length (e.g., 4 KiB) and strip control chars.
- **Git protocol attacks:** none in this task because we only deal with the local bare repo. When a future `@ax/workspace-git-http` lands, re-run the checklist.
- **Supply chain:** pinning `isomorphic-git` — check advisory DB (`npm audit --production`) before committing the dep.

Record the checklist output as `packages/workspace-git/SECURITY.md` — one page, the filled-in template.

Commit (security-note only, no impl yet): `chore(workspace-git): scaffold + security checklist`.

### Task 6 — Implement `workspace:apply` / `read` / `list` / `diff`

Build the bare repo on first `init()` under `<dataDir>/workspace.git` (data dir comes from config; default `./ax-next-workspace.git` for dev). Every `apply`:

1. Stage blobs via `writeBlob` for each `put`.
2. Build tree from parent tree + changes. Deletes remove entries.
3. Create commit with `parent` as parent commit. `reason || 'agent apply'` is the commit message. Author is derived from `ctx` (agentId → name; sessionId → email-shaped tag).
4. Atomically update a ref (`refs/ax/workspace`) using expected-old-SHA to implement Section 4.5's optimistic concurrency. Mismatch → throw `PluginError` with `code: 'workspace_conflict'`.
5. Build the `WorkspaceDelta` by `diff-tree`-ing parent → new commit. Wire `contentBefore` / `contentAfter` as lazy fetchers that call `readBlob` on access.

`WorkspaceVersion` is `asWorkspaceVersion(sha)`. Nothing outside this package ever inspects the string.

**Tests (package-local, before the shared suite in Task 7):**
- write/read round-trip
- conflict on stale parent
- binary-safe bytes (e.g., a PNG)
- path normalization rejects `../escape`
- oversized `reason` is truncated or rejected (pick one — document)

Commit: `feat(workspace-git): implement Section 4.5 service hooks against a bare repo`.

### Task 7 — Run the shared contract suite against `@ax/workspace-git`

```ts
// packages/workspace-git/src/__tests__/contract.test.ts
import { runWorkspaceContractSuite } from '@ax/test-harness';
import { bootWorkspaceGit } from './helpers.js'; // boots the plugin on a tmp dir
runWorkspaceContractSuite('@ax/workspace-git', bootWorkspaceGit);
```

Expect some assertions to fail initially. Fix the git impl — **not the suite** — until every assertion passes. If a suite assertion is provably git-hostile (e.g., asserts behavior only a content-addressed store can give), surface it to the reviewer before weakening the suite; the whole point is the suite catches divergence.

Commit: `test(workspace-git): passes shared workspace contract suite`.

**Phase B checkpoint:** code review. Explicitly check: no `sha` / `commit` / `branch` string appears in any hook payload key. Grep `packages/workspace-git/src` for those words — any match outside the impl internals is a leak.

---

## Phase C — Postgres plugins

### Task 8 — `@ax/database-postgres`

**Files:** `packages/database-postgres/{…}` — same layout as other plugins.

**Dependencies:** `kysely`, `pg`. Pin exact versions; record in package `README.md` why (supply chain paranoia).

**Shape:** plugin registers one service hook, `database:get-instance`, returning a `Kysely<Database>` instance. `Database` here is an **empty generic** — store plugins augment it with their own table types via declaration merging. The connection pool is owned by this plugin; it's configured from `ctx.config.database.postgres.{connectionString,poolSize}`.

**`security-checklist` scope "database-postgres":**
- **Connection-string handling:** never log it. When logging pool errors, redact `postgres://user:PASS@host/db` → `postgres://user:***@host/db`. Test this.
- **SQL injection:** Kysely parametrizes, but verify no `sql\`…${untrusted}…\`` interpolation ever reaches user-supplied values. ESLint rule or grep check in CI.
- **TLS:** require TLS by default (`ssl: { rejectUnauthorized: true }`); allow opt-out only via an explicit `insecure: true` config flag, and log a `ctx.logger.warn('database_tls_disabled')` on every startup when it's set.
- **Supply chain:** `pg` has a long history of CVEs in its parser — pin, and subscribe to advisories. Note this in SECURITY.md.

**Tests:** use `@testcontainers/postgresql` for a real pg in CI. Skip the container tests locally behind `AX_SKIP_PG_TESTS=1` for people without Docker; CI sets it up.

Commit: `feat(database-postgres): Kysely+pg connection pool plugin`.

### Task 9 — `@ax/storage-postgres`

Replaces `@ax/storage-sqlite`. Same hooks: `storage:get(key) → value`, `storage:set(key, value) → void`. Owns its **own** table (`ax_storage`) and its **own** migrations. No cross-plugin FKs (invariant per Section 6).

**Migrations:** each migration is a numbered file; at `init()` the plugin calls `database:get-instance`, runs any migrations whose id > last recorded in `ax_storage_migrations` (its own bookkeeping table). Idempotent. Tests must assert that running `init()` twice on the same DB is a no-op.

**`security-checklist` scope "storage-postgres":**
- Keys are caller-supplied — length-bound them (e.g., ≤ 512 bytes) and reject non-ASCII to simplify reasoning.
- Values: we store arbitrary bytes; callers are responsible for encryption if they pass secrets. Document this in the package README under a "What this plugin is NOT" header so no one accidentally stores credentials in it.
- SQL: only Kysely; grep enforces no raw `sql\`\``.

**Contract parity test:** port `packages/storage-sqlite/src/__tests__/*` as a shared suite in `@ax/test-harness` (similar to Task 4), run it against both backends. If the sqlite tests are too specific to sqlite, extract the hook-surface-only assertions and skip the sqlite-internal ones. Same rule as the workspace suite — failure in either backend is a contract bug.

Commit: `feat(storage-postgres): Postgres-backed storage plugin` + a separate commit `test(storage): shared contract suite + sqlite parity`.

### Task 10 — `@ax/session-postgres`

Sessions pin SSE streams to replicas. Hooks: `session:lookup(sessionId) → { replicaId, createdAt } | null`, `session:store(sessionId, replicaId, ttlSeconds) → void`, `session:delete(sessionId) → void`.

**`security-checklist` scope "session-postgres":**
- Session IDs are security-sensitive. **Never log them at info level.** Log only a prefix (first 8 chars) + `…`.
- TTL: enforce a hard max (e.g., 24h). Refuse longer.
- Expired-session sweep: a background `setInterval` or a lazy-on-read deletion. Pick one; document. If `setInterval`, shut it down cleanly on plugin dispose (tests verify no handle leaks).
- **Cross-replica:** a `session:store` on replica A must be immediately visible to replica B. No local cache. Assert via a two-replica testcontainer test if feasible; otherwise via a cache-invalidation test that just times out if caching sneaks in.

Commit: `feat(session-postgres): session affinity store for SSE pinning`.

### Task 11 — `@ax/eventbus-postgres`

LISTEN/NOTIFY. Contract matches `@ax/eventbus-inprocess` (Task 2) **exactly** — same suite of tests from test-harness runs against both.

**Implementation notes:**
- Channel names: `pg_notify(channel, payload)` quotes channels via `format('%I', …)` — but we still enforce `[a-z0-9:_-]+` at our layer (Kysely doesn't expose format; we validate and reject before the call).
- Payload size: pg caps NOTIFY at 8000 bytes. Reject payloads larger at `emit` with a structured error. Test with a 9000-byte payload.
- One LISTEN per subscribed channel per process; N subscribers on the same channel fan-out in-process from the single LISTEN.
- Reconnect: if the pg connection drops, re-LISTEN on reconnect. Do not silently lose subscribers.

**`security-checklist` scope "eventbus-postgres":**
- Channel name injection: already enforced at the regex, but add a test that `';DROP TABLE'` is rejected.
- Payload is untrusted (any replica can NOTIFY) — subscribers must not `eval`/deserialize-to-class. Document this in the package README.

Shared eventbus contract suite (in test-harness) covers the common assertions. This task also runs the suite against the inprocess bus from Task 2 — confirming both are contract-clean.

Commit: `feat(eventbus-postgres): LISTEN/NOTIFY bus + shared contract suite`.

### Task 12 — Phase C checkpoint

Before moving on:

```bash
pnpm build
pnpm test
```

Both must be green with pg containers. Invoke `superpowers:requesting-code-review` over Phase C's diff. Verify:
- no plugin from Phase C imports another (invariant 2 — grep `from '@ax/`)
- every plugin ships a `SECURITY.md`
- migrations are per-plugin, no cross-plugin FKs

Commit: `chore: Phase C complete` — empty commit with summary is fine.

---

## Phase D — k8s, preset, acceptance

### Task 13 — `@ax/sandbox-k8s`

The heaviest port. Legacy lives at `~/dev/ai/ax/` — the "Task 1-7" work the handoff mentions. Walk the legacy pod-lifecycle code (search for `reqId`, `kill-with-reqId`, `lifecycle_reason`) and port:

- **Per-pod logger** bound with `reqId` + `podName`
- **Lifecycle reason capture** — every pod termination records a reason (`agent_done`, `timeout`, `oom`, `killed_externally`, `host_requested`) into a structured event
- **Kill-with-reqId** — a host-initiated kill tags the pod's termination with the originating `reqId` so the chat_terminated event can cite it

These are the explicitly-carryover pieces. **Do not port legacy's orchestration glue** (pool managers, speculative spawn, etc.) — v2 spawns on demand and lets k8s be k8s.

Same `sandbox:spawn(config) → SandboxHandle` hook as `@ax/sandbox-subprocess`. `SandboxHandle` exposes `send(msg)`, `recv()`, `kill(reason)`. Transport under the hood is HTTP to an in-pod agent listener. **Do not leak the URL into the hook surface** — the handle is an opaque object.

**`security-checklist` scope "sandbox-k8s" — the big one:**

Three threat models all apply; walk them explicitly and record in `packages/sandbox-k8s/SECURITY.md`:

1. **Sandbox escape (pod → node → cluster):**
   - RBAC: service account has ONLY `pods: create, delete, get, list` in its own namespace. No cluster-scope. No `exec`. (`exec` is a frequent foot-gun; we stream via HTTP to the pod's own listener instead.)
   - PodSecurityContext: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, drop ALL capabilities.
   - NetworkPolicy: egress only to the host's in-cluster Service; no internet.
   - Seccomp: `RuntimeDefault` at minimum.
   - Record legacy's pod spec and diff what we're keeping vs dropping.
2. **Prompt injection (LLM output → tool → k8s):**
   - The `command` passed to `sandbox:spawn` originates from LLM output via `@ax/tool-bash`. Treat as untrusted. Never interpolate it into a `kubectl` or shell command on the host — we only feed it to the pod over the IPC transport as a structured payload.
   - Image pinning: use a digest (`@sha256:…`), not a tag. An attacker who can push to the tag otherwise owns every sandbox.
3. **Supply chain:**
   - `@kubernetes/client-node` — pin exact version. Audit transitive deps.
   - The in-pod agent image is a first-party artifact we build; note where it's built from and how its digest is recorded.

**Tests:** mock the `@kubernetes/client-node` at the HTTP level (nock or msw-node). Acceptance verification against a real cluster happens in Task 17.

Commit: `feat(sandbox-k8s): k8s pod sandbox with per-pod logger and lifecycle reason capture`.

### Task 14 — `@ax/preset-k8s` (meta-package)

**Files:** `presets/preset-k8s/{package.json, src/index.ts}`.

`src/index.ts` exports a `plugins` array of plugin-factory refs: `database-postgres`, `storage-postgres`, `eventbus-postgres`, `session-postgres`, `workspace-git`, `sandbox-k8s`, `llm-anthropic`, `tool-bash`, `tool-file-io`, `tool-dispatcher`, `audit-log`. Plus the CLI-side helpers already in `@ax/preset-local` (or whatever Week 4–6 called it — verify).

**Invariant check during this task:** does `@ax/preset-local` still compile + test after Phase C? It must. If a store plugin's `init()` accidentally requires postgres, that's the bug — fix the store, not the preset.

Commit: `feat(preset-k8s): k8s deployment-shape preset`.

### Task 15 — Deploy manifests (port from legacy)

**Files:** `deploy/k8s/` — raw YAML manifests. `Namespace`, `ServiceAccount` + minimal `Role`/`RoleBinding`, `Deployment` for the ax-host, `Service` (ClusterIP for in-cluster, optional `LoadBalancer` for dev access), `ConfigMap` for `ax.config.ts`-derived settings, `NetworkPolicy` for the egress lockdown.

**Port from `~/dev/ai/ax/deploy/`** (or wherever legacy keeps manifests). Do not redesign; this is plumbing.

Include a `deploy/k8s/README.md` with exactly three commands:
```bash
kind create cluster --name ax-next
kubectl apply -k deploy/k8s/
kubectl port-forward svc/ax-host 8080:80
```

Document the Postgres requirement: either a sidecar StatefulSet (simplest for dev), or an external instance via connection string in a Secret. Pick sidecar for the acceptance test because it's self-contained.

Commit: `chore(deploy): k8s manifests ported from legacy`.

### Task 16 — Wire acceptance: CI path (mocked k8s + real pg)

Automated end-to-end that runs in CI:

- testcontainers-postgresql + mocked k8s API at the HTTP level
- boots the full k8s preset
- sends a chat message via the in-process core (not via CLI subprocess, to keep the test fast)
- asserts: an LLM call fired, a bash tool call ran in a "pod", workspace:applied observed at least once, chat:end emitted with `kind: 'complete'`

Time budget: under 45s. If it creeps past 60s, split the postgres setup into a `beforeAll` that survives across tests.

Commit: `test: end-to-end acceptance on k8s preset (mocked cluster, real pg)`.

### Task 17 — Manual acceptance on a real cluster

Not automated; checklist lives in `docs/runbooks/week-7-9-acceptance.md`. Human (Vinay) runs kind, applies manifests, sends a chat via the CLI with config pointed at the cluster, watches `kubectl logs` for the per-pod logger output, checks the git workspace (`git log refs/ax/workspace`) has a commit from the bash call.

The session that executes this plan does NOT attempt the manual acceptance step itself — it produces the runbook and stops. Vinay runs it.

Commit: `docs(runbook): week 7-9 manual acceptance on kind`.

---

## Final integration checks (before the PR)

Run as a single subagent at the end:

```bash
pnpm build
pnpm test
pnpm --filter @ax/cli test          # config loader still loads both presets
grep -rE "'(sha|commit|branch|ref|bundle|pod_name|socket_path)'" \
   packages/*/src --include='*.ts' || echo "no leaked vocabulary"
pnpm audit --production             # supply chain sanity
```

Then `/superpowers:requesting-code-review` over the whole branch, followed by the `security-checklist` skill one final time with scope "whole slice" — this catches cross-plugin concerns a per-package run misses (e.g., did two plugins independently grant themselves the same k8s verb?).

PR body must answer the **boundary review** questions from CLAUDE.md for every new service hook introduced in this slice (workspace:apply/read/list/diff; database:get-instance; session:lookup/store/delete; eventbus:emit/subscribe). One paragraph per hook. Don't skip.

## What's intentionally out of scope

Per the handoff document:

- `@ax/workspace-git-http` (multi-replica) — Week 10+
- `@ax/audit-postgres` — audit is Week 10; keep using the file/sqlite audit for now
- Helm charts — raw manifests are fine; Helm if/when we actually need templating
- Canary scanner wiring into `workspace:pre-apply` — Week 10–12 lands `@ax/scanner-canary`; the hook is the integration point, but subscribing is not our task here

## Risk log (worth flagging to the reviewer up front)

- **pg LISTEN/NOTIFY payload size (8KB)** may be too small for some future use. We reject large payloads today; future reference-passing-via-storage pattern is the escape hatch.
- **isomorphic-git performance on large workspaces** — adequate for the acceptance test; if it becomes a bottleneck in Week 10+, swap to shelling out to `git` binary under the same hooks.
- **kind vs real GKE** — GKE Autopilot has extra PodSecurity admission; the manifests written against kind may need adjustment. Verify on real GKE before claiming "production-ready."

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-04-23-week-7-9-k8s-deployment.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Recommended for this plan because Phase A's contract work is load-bearing and wants tight review loops.

**2. Parallel Session (separate)** — open a new session with `superpowers:executing-plans`, batched execution with checkpoints between phases.

Which approach?
