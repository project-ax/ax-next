# Workspace redesign — Phase 2 implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Close the Phase 1 half-wired window. Promote `@ax/workspace-git-server`'s test-only host-side adapter into a registered, production-grade plugin (`createWorkspaceGitServerPlugin`) that speaks standard git protocol to the new storage tier; wire it into `@ax/preset-k8s` and the Helm chart behind the existing `gitServer.experimental.gitProtocol` toggle so an operator can flip a single boolean and the entire stack — host plugin + storage tier — switches over together.

**Architecture:**

- Add a third arm to `K8sWorkspaceConfig`: `{ backend: 'git-protocol'; baseUrl: string; token: string; cacheRoot?: string }`. Picked at deploy time from the new env vars `AX_WORKSPACE_GIT_SERVER_URL`, `AX_WORKSPACE_GIT_SERVER_TOKEN`. The Helm chart stamps these onto the host pod when `gitServer.experimental.gitProtocol=true`.
- Sandbox-host wire stays `FileChange[]` per design doc (bundle wire is Phase 3). The plugin translates bus calls into git operations against a per-workspace local-mirror cache and pushes to the storage tier with `--force-with-lease`.
- Promotion in place: rename `src/client/plugin-test-only.ts` → `src/client/plugin.ts`, add the production factory `createWorkspaceGitServerPlugin({ baseUrl, token, ... })` alongside the existing `createTestOnlyGitServerPlugin` (which keeps its `boot()` callback shape for the contract harness). Both share the underlying git-ops engine.
- Production plugin adds: retry-with-backoff on transient errors (matching `@ax/workspace-git-http`'s shape), a per-workspace mirror cache that survives across hook calls in the same plugin instance, real `shutdown()` that drains the per-workspace queues and removes mirrors, and 4xx → `PluginError` mapping (especially `parent-mismatch` carrying `cause.actualParent`).
- Workspace-id derivation: a deterministic function `workspaceIdFor(ctx)` that hashes `(userId, agentId)` into the `^[a-z0-9][a-z0-9_-]{0,62}$` regex. The hash is the SHA-256 first 16 hex chars, prefixed `ws-`. Used to name the bare repo on the storage tier (one repo per workspace).
- **Sharding deferred.** Phase 1 shipped `gitServer.shards` (default 1) and the `shardForWorkspace`/`shardUrl` primitives in `shared/`. At MVP we always run N=1, so per-call shard routing is identity and pure dead code on the host plugin. We push the addressing concern to the chart: a small ClusterIP Service in front of the experimental StatefulSet gives the host plugin a single stable URL to hit. When/if we actually need N>1, we add the routing layer then — alongside the operational re-sharding tooling that the design doc already deferred. (See Q5 below.)
- Helm chart: extend `host/deployment.yaml` so that when `gitServer.experimental.gitProtocol=true`, the host pod gets the `git-protocol` env vars pointing at the new ClusterIP Service. The legacy `http` env vars only render when the toggle is OFF (mutual exclusion).

**Tech stack:** TypeScript (Node 20+), `child_process.spawn` (argv-array only — same paranoid env discipline as Phase 1), Node `crypto` for SHA-256, Vitest, Helm. No new runtime deps.

---

## Open questions (need user decision before code)

These shape the surface and need a yes/no before Task 1.

### Q1. Plugin location: same package vs. extracted

Options:
- (a) Keep in `@ax/workspace-git-server/src/client/plugin.ts`. Same package as the storage tier server. The package's existing `index.ts` adds `createWorkspaceGitServerPlugin` to its public exports; the server-side `bin: ax-git-server` and the host-side plugin coexist (same shape `@ax/workspace-git-http` already uses — server + plugin in one package).
- (b) Extract a new package `@ax/workspace-git-server-client` that depends on `@ax/workspace-git-server` for the shared types only, exporting just the host plugin.

**Recommend (a).** It mirrors `@ax/workspace-git-http`'s shape exactly (server + plugin in one package, two `exports` entries, one `bin`). Splitting into two packages adds a dependency edge with zero new isolation benefit — the host plugin already only imports `@ax/core` and the package's own `client/repo-lifecycle.ts` and `shared/*`. I2 (no cross-plugin imports) is satisfied either way.

### Q2. How does the plugin determine `workspaceId` per call?

The four `workspace:*` hooks today carry no `workspaceId` — `WorkspaceContext` carries only `rootPath` (a filesystem path string). The plugin needs a workspaceId to name the bare repo on the storage tier (one repo per workspace).

Options:
- (a) **Derive from `ctx.agentId`** — sanitize+truncate to fit `^[a-z0-9][a-z0-9_-]{0,62}$`. One workspace per agent. Matches the agent-centric design's "every agent has its own workspace."
- (b) **Derive from `(ctx.userId, ctx.agentId)`** — SHA-256 first 16 hex chars, prefixed `ws-`. More distribution; immune to agentId-collision across users. Format: `ws-<hex16>`.
- (c) **Add `workspaceId` field to `WorkspaceContext`** — explicit, no derivation magic. But it's a `@ax/core` type change that ripples through every callsite of `makeAgentContext` (CLI canary, runner, every test). Bigger blast radius.
- (d) **Configure one workspaceId per host plugin instance** — one host pod = one workspace. Doesn't multi-tenant; equivalent to today's `workspace-git-http` posture.

**Recommend (b).** Deterministic derivation from `(userId, agentId)`, no contract change, immune to collisions. Format: `ws-` + first 16 hex chars of `sha256(userId + '/' + agentId)`. Total length 19 chars, fits the regex (`^[a-z0-9][a-z0-9_-]{0,62}$`), starts with `w` (lowercase letter), contains only `[a-z0-9-]`. Same derivation tested in `workspaceIdFor.test.ts`. A future Phase that wants explicit IDs adds (c) without breaking (b)'s callers.

### Q3. Mirror cache lifetime

The plugin maintains a per-workspace bare repo mirror locally for fast `git ls-tree`/`cat-file`/`diff-tree` reads. Question: how long do mirrors live?

Options:
- (a) **Per-call**: tempdir-mirror per `workspace:apply` call, deleted on return. Cold-start cost on every call (full `git fetch` from storage tier).
- (b) **Per-plugin-instance with LRU eviction**: cache lives for the host pod's lifetime; `git fetch` only on first touch + on parent-mismatch retry. Bounded size (default: 64 mirrors, ~1 GB total at 16 MB/mirror p99); LRU eviction on overflow.
- (c) **Persistent on disk**: cache outlives pod restarts via a configured `cacheRoot` (chart-mounted emptyDir or PVC).

**Recommend (b)** for MVP. (a) is too slow for production (every apply is a full fetch); (c) is needless complexity for Phase 2 — pods restart rarely, and a cold-start fetch is seconds. Configurable `cacheMaxEntries` (default 64) on the plugin options. SECURITY.md notes that mirror dirs are tempdir-scoped and contain only metadata (commits, trees, blobs) — no secrets.

### Q4. Retry policy: do we mirror `workspace-git-http`'s shape exactly?

The legacy plugin retries connection errors and 5xx with exponential backoff (100ms, 200ms, ... cap 30s, max 5 attempts). 4xx → never retry; `PluginError` with `code: 'parent-mismatch'` for 409 carrying `cause.actualParent`/`expectedParent`.

For Phase 2, retries split across two surfaces: (1) REST CRUD (`POST /repos`, `GET /repos/<id>`) and (2) git smart-HTTP (the `git fetch`/`git push` invocations). Options:
- (a) **REST gets the same retry policy as `workspace-git-http`** (already inherited from the existing `RepoLifecycleClient` — but verify it has retry; if not, add it). **Git smart-HTTP relies on `git`'s own retry**: `git -c http.lowSpeedLimit=...` etc. None added by us; if `git fetch` fails transiently, the plugin surfaces it as a transient error and our outer retry retries the entire op (including `git fetch`).
- (b) Wrap `git fetch`/`git push` in our own retry loop with a bounded attempt count.

**Recommend (a)** — let `git` handle git-internal retries; our outer retry loop catches whole-op transient failures (network blips during an apply). Bounded at 5 attempts with backoff matching `workspace-git-http`. Concurrency-related failures (CAS mismatch) are NOT retried by the plugin — they surface as `parent-mismatch` and the orchestrator/caller decides whether to rebase. (Same as `workspace-git-http` today.)

### Q5. Sharding: build it now or defer?

Phase 1 shipped `gitServer.shards` (default 1) and the primitives `shardForWorkspace` / `shardUrl` in `src/shared/`. The original Phase 2 plan added a host-side router (`shardUrlForWorkspace`) and propagated `shards`/`serviceName`/`namespace`/`port` through the plugin options and env-var loader.

But: at MVP we always run N=1. With N=1, `shardForWorkspace(any, 1) === 0` always — the routing math is identity, and the four host-plugin options collapse to a single base URL. The design doc itself says "Initial deployment picks `N` and lives with it" and "re-sharding is operational, not architectural" — both deferring the actual scaling story.

Options:
- (a) **Build the router now anyway.** Pros: fewer code changes if/when N>1 happens. Cons: pure dead code at N=1; tightens the chart→preset→plugin coupling (4 env vars instead of 1) for zero MVP benefit; over-couples the host plugin to the per-pod-DNS addressing primitive.
- (b) **Defer.** Plugin takes `baseUrl: string`. Chart adds a small ClusterIP Service in front of the experimental StatefulSet (one-pod target today, easy to keep working at N=1). When/if we need N>1, we add the routing layer then alongside the operational re-sharding tooling that the design already deferred.

**Recommend (b).** Same YAGNI logic the design doc already applied to re-sharding tooling — there's no benefit to landing speculative routing code that exercises only the identity path. If N>1 ever becomes load-bearing, the chart, plugin, and operational story all need work; doing one third of it speculatively now doesn't shorten the eventual delta. The chart's `gitServer.shards` stays as a knob (so STS replicas scale if an operator turns it up); the host plugin just doesn't *care* about N because we put a Service in front.

This was a late revision to the plan after the original Q1–Q6 — the sharding tasks (formerly Tasks 3+4) have been removed from the bite-sized list. If you'd rather build sharding into Phase 2 anyway, push back and we'll restore them.

### Q6. Canary surface: how does an operator verify Phase 2 in production?

Phase 1 shipped with a chart toggle that gates the StatefulSet but didn't actually serve traffic. Phase 2 closes that loop: the toggle now flips the host's plugin too. Question: do we add explicit canary plumbing (e.g., per-team toggle, A/B routing) or just the global toggle?

Options:
- (a) **Global toggle only** (current `gitServer.experimental.gitProtocol`). Per-deploy choice; rollback via `helm upgrade --reuse-values --set gitServer.experimental.gitProtocol=false`.
- (b) **Per-team or per-workspace toggle** for true canary (one user, one team gets the new path; everyone else stays on legacy).

**Recommend (a)** for Phase 2. (b) requires routing logic in the host plugin that knows which workspaces go where — that's a bigger feature and not on the critical path. The MVP canary is "deploy to a staging cluster with toggle on, observe, deploy to prod with toggle on if happy." If a soak window surfaces a problem the global rollback is one helm command.

### Q7. Acceptance test: does `preset-k8s/__tests__/acceptance.test.ts` need to exercise the new path?

Today's test uses `workspace.backend: 'local'` and drops `@ax/workspace-git-http` + `@ax/workspace-git` from the plugin set. Question: do we add a parallel test for `backend: 'git-protocol'` (booting an in-process `@ax/workspace-git-server` + the new plugin)?

Options:
- (a) **Add a parallel `it()`** that boots the new path and runs through the same chat-end recorder canary. Heavier but proves end-to-end coverage.
- (b) **Drop the new plugin from the kept set** (same as the current legacy ones) and rely on the package-level contract test + multi-replica test to prove the plugin works.

**Recommend (a)**. The half-wired-window discipline says the canary acceptance test must reach the new plugin. The package-level tests prove the plugin works in isolation; the preset acceptance test proves it works in the registered, kernel-bootstrapped flow alongside the rest of the chat path. Without (a), nothing in CI exercises `createK8sPlugins` registering the new plugin.

If any of these recommendations are wrong, flag before coding starts.

---

## Cross-phase observations

### What Phase 1 left for us, exactly

Phase 1 shipped:
- `@ax/workspace-git-server` package with server (container-shipped) + REST CRUD client + test-only host adapter (`plugin-test-only.ts`).
- Chart toggle `gitServer.experimental.gitProtocol` (default OFF) gating the StatefulSet, headless Service, NetworkPolicy.
- 393 tests passing including `runWorkspaceContract` against the test-only adapter.

Phase 1 explicitly did NOT:
- Register any production host plugin against the new tier.
- Switch the host pod's env vars when the toggle flips.
- Run an end-to-end test from `agent:invoke` → `workspace:apply` → new tier.

Phase 2 closes all three.

### Why the test-only plugin can't just be promoted unchanged

Reading `plugin-test-only.ts` against production needs:

| Today (test-only) | Phase 2 production |
|---|---|
| `boot()` callback yields `{ baseUrl, token, workspaceId }` once | Plugin takes `{ baseUrl, token, ... }` at construct time; derives `workspaceId` per call from `ctx` |
| One mirror per plugin instance, fixed at init | Per-workspace mirror dictionary, populated lazily |
| Per-plugin queue serializes ALL hook calls | Per-workspace queue (multiple workspaces can apply concurrently) |
| No retry on transient failures | REST + outer-op retry with backoff (matching `workspace-git-http`) |
| Throws plain `Error` for non-CAS git push failures | All 4xx → `PluginError` with stable `code` field; transient → retry |
| `shutdown()` removes mirror, sets state=null | `shutdown()` drains all per-workspace queues, then removes all mirrors |

The shared engine (apply pipeline, diff-tree → WorkspaceDelta hydration, blob reading) is reused. Phase 2 refactors `plugin-test-only.ts` so the engine lives in shared modules; both factories wrap it.

The plugin takes a single `baseUrl` (per Q5) — no per-call URL composition, no shard math.

### Workspace-id derivation: how it lands

A new file `src/client/workspace-id.ts`:

```ts
import { createHash } from 'node:crypto';

export function workspaceIdFor(ctx: { userId: string; agentId: string }): string {
  const h = createHash('sha256')
    .update(ctx.userId)
    .update('/')
    .update(ctx.agentId)
    .digest('hex');
  return `ws-${h.slice(0, 16)}`;
}
```

Tests prove:
- Determinism: same `(userId, agentId)` → same workspaceId across 1000 calls.
- Regex: result always matches `WORKSPACE_ID_REGEX` from `src/shared/workspace-id.ts`.
- Distinct collisions: `(u1, a1)` and `(u2, a1)` produce different IDs (no agentId-only collision).

Test-only path keeps its `boot()`-supplied workspaceId so the contract harness can use a fresh ID per scenario. Production path derives it from ctx — no `boot()` needed.

---

## Plugin shape

### File layout after Phase 2

```
packages/workspace-git-server/
├── src/
│   ├── client/
│   │   ├── plugin.ts                # NEW — production factory + test-only factory
│   │   ├── plugin-test-only.ts      # DELETED — folded into plugin.ts (keeps the test-only export)
│   │   ├── workspace-id.ts          # NEW — workspaceIdFor(ctx)
│   │   ├── git-engine.ts            # NEW — shared apply/read/list/diff git ops (extracted from plugin-test-only.ts)
│   │   ├── mirror-cache.ts          # NEW — per-workspace bare-mirror cache with LRU
│   │   ├── retry.ts                 # NEW — exponential-backoff retry helper (mirrors workspace-git-http/client.ts)
│   │   ├── repo-lifecycle.ts        # UNCHANGED — Phase 1
│   │   └── __tests__/
│   ├── shared/
│   │   ├── shard.ts                 # UNCHANGED — Phase 1; not used by the host plugin (sharding deferred)
│   │   ├── repo-path.ts             # UNCHANGED
│   │   ├── workspace-id.ts          # UNCHANGED — server-side regex; plugin imports via workspace-id-regex export
│   │   └── __tests__/
│   ├── server/                      # UNCHANGED — Phase 1
│   ├── index.ts                     # UPDATED — exports createWorkspaceGitServerPlugin (production) + createTestOnlyGitServerPlugin (test-only, named clearly)
│   └── __tests__/
│       ├── contract.test.ts         # UPDATED — runs against PRODUCTION factory, with a one-workspace boot harness
│       ├── multi-replica.test.ts    # NEW — three production-plugin instances, one storage tier, concurrency assertions (mirrors workspace-git-http/multi-replica.test.ts)
│       ├── subscriber-no-leak.test.ts  # NEW — boundary review enforcement: no oid escapes into subscriber-visible payloads
│       └── integration/             # UNCHANGED Phase 1 tests; multi-replica-concurrency.test.ts may be deleted or marked legacy if subsumed
```

### Public API

```ts
// src/index.ts (updated)

// Phase 2 production factory.
export {
  createWorkspaceGitServerPlugin,
  type CreateWorkspaceGitServerPluginOptions,
} from './client/plugin.js';

// Test-only factory (boot()-driven; used by runWorkspaceContract harnesses
// that need a fresh server + workspaceId per scenario). NOT registered by
// any preset.
export {
  createTestOnlyGitServerPlugin,
  type CreateTestOnlyGitServerPluginOptions,
} from './client/plugin.js';

// Shared util surfaced for testing + alternate-deployment scenarios.
export { workspaceIdFor } from './client/workspace-id.js';

// Server-side exports (unchanged from Phase 1) under './server' subpath.
```

### `CreateWorkspaceGitServerPluginOptions`

```ts
export interface CreateWorkspaceGitServerPluginOptions {
  /** Cluster-internal base URL of the storage tier, e.g. `http://ax-next-git-server-experimental.ax-next.svc.cluster.local:7780`. Provided by the chart. */
  baseUrl: string;
  /** Bearer token for REST + git smart-HTTP auth. Never logged. */
  token: string;
  /** Optional override for the local mirror cache root. Default: tempdir-scoped per plugin instance. */
  cacheRoot?: string;
  /** Optional override for max cached mirrors (LRU eviction). Default 64. */
  cacheMaxEntries?: number;
  /** Optional override for retry attempts (default 5) and backoff base (default 100ms). */
  retry?: { maxAttempts?: number; backoffBaseMs?: number };
  /** Optional injection point for tests that want to mock the workspaceId-from-ctx derivation. Production callers leave unset. */
  workspaceIdFor?: (ctx: { userId: string; agentId: string }) => string;
}
```

The `workspaceIdFor` injection point lets tests collide workspaceIds intentionally (e.g., the multi-replica test wants three plugin instances pointing at the SAME workspace).

Sharding is deferred (per Q5). When/if we need N>1 storage tier pods, we add `serviceName` / `namespace` / `port` / `shards` and a `shardUrlForWorkspace` call site here, alongside chart routing changes — but not now.

### Engine shape (shared between production + test-only)

`src/client/git-engine.ts` exports a `GitEngine` factory that takes `{ mirrorCache, lifecycleClient, retry, runGit }` and exposes:

```ts
interface GitEngine {
  apply(workspaceId: string, input: WorkspaceApplyInput): Promise<WorkspaceApplyOutput>;
  read(workspaceId: string, input: WorkspaceReadInput): Promise<WorkspaceReadOutput>;
  list(workspaceId: string, input: WorkspaceListInput): Promise<WorkspaceListOutput>;
  diff(workspaceId: string, input: WorkspaceDiffInput): Promise<WorkspaceDiffOutput>;
  shutdown(): Promise<void>;
}
```

Both factories build a `GitEngine` and register the four hooks against it. The production factory wraps each call with `workspaceIdFor(ctx)`; the test-only factory uses the boot-supplied workspaceId verbatim.

### Per-workspace queue

Per-workspace serialization is required because git `--force-with-lease` between two simultaneous applies on the same workspace would hammer the storage tier with retries unnecessarily. The shared engine's `apply` enqueues onto a per-workspace promise chain; reads/diffs run concurrently with applies (they only fetch, no commit).

The mirror cache holds one queue per workspace; LRU eviction also drains the queue and removes the mirror dir.

---

## Preset wiring

### `K8sWorkspaceConfig` becomes a three-arm union

```ts
// presets/k8s/src/index.ts
export type K8sWorkspaceConfig =
  | { backend: 'local'; repoRoot: string }
  | { backend: 'http'; baseUrl: string; token: string }
  | { backend: 'git-protocol'; baseUrl: string; token: string };
```

`createK8sPlugins(config)` adds a third branch:

```ts
if (config.workspace.backend === 'git-protocol') {
  plugins.push(
    createWorkspaceGitServerPlugin({
      baseUrl: config.workspace.baseUrl,
      token: config.workspace.token,
    }),
  );
} else if (config.workspace.backend === 'http') {
  // existing legacy path — unchanged
} else {
  // existing local path — unchanged
}
```

### `workspaceConfigFromEnv` extends

```
AX_WORKSPACE_BACKEND               local | http | git-protocol   (default: local)
AX_WORKSPACE_GIT_SERVER_URL        required when backend === 'git-protocol'
AX_WORKSPACE_GIT_SERVER_TOKEN      required when backend === 'git-protocol'
```

Validation: both required when backend is `git-protocol`; throw with sanitized error (no token leak) on missing values.

### Acceptance test addition

`presets/k8s/src/__tests__/acceptance.test.ts` adds a parallel `it('git-protocol backend ...')` that:
1. Boots an in-process `@ax/workspace-git-server` instance on a tempdir repoRoot.
2. Builds a `K8sPresetConfig` with `workspace: { backend: 'git-protocol', baseUrl: 'http://127.0.0.1:<bound-port>', token }`.
3. Drops the legacy plugins (`@ax/workspace-git`, `@ax/workspace-git-http`) from the kept set; the new plugin is kept.
4. Runs through the same chat-end recorder canary as the `local` test.

The new plugin name `@ax/workspace-git-server` is removed from `PLUGINS_TO_DROP` for this test only (or the test uses a separate filter set).

---

## Helm chart additions

### `host/deployment.yaml` env block

Add a new branch for `git-protocol`:

```yaml
- name: AX_WORKSPACE_BACKEND
  value: {{ .Values.workspace.backend | quote }}
{{- if eq .Values.workspace.backend "local" }}
- name: AX_WORKSPACE_ROOT
  value: {{ .Values.workspace.mountPath | quote }}
{{- else if eq .Values.workspace.backend "http" }}
- name: AX_WORKSPACE_GIT_HTTP_URL
  value: {{ printf "http://%s.%s.svc.cluster.local:%v" (include "ax-next.gitServerComponentName" .) .Release.Namespace .Values.gitServer.service.port | quote }}
- name: AX_WORKSPACE_GIT_HTTP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "ax-next.gitServerSecretName" . }}
      key: token
{{- else if eq .Values.workspace.backend "git-protocol" }}
- name: AX_WORKSPACE_GIT_SERVER_URL
  value: {{ include "ax-next.gitServerExperimentalServiceUrl" . | quote }}
- name: AX_WORKSPACE_GIT_SERVER_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "ax-next.gitServerAuthSecretName" . }}
      key: token
{{- end }}
```

### `values.yaml` — extend `workspace.backend` to allow `git-protocol`

Update the comment block at line 75–87 to document the third value. Add a NOTES.txt warning that `backend: git-protocol` requires `gitServer.enabled=true` AND `gitServer.experimental.gitProtocol=true`. The chart helper `_helpers.tpl` adds a validation function that fails `helm template` if `backend: git-protocol` is set without both toggles on.

### Mutual exclusion

When `gitServer.experimental.gitProtocol=true`:
- The host's env vars switch to the `git-protocol` set (per the deployment.yaml branch above).
- The chart still renders both the legacy `Deployment` (under `gitServer.enabled` only) AND the new `StatefulSet` (under both toggles). They coexist physically; only one serves traffic per the `workspace.backend` choice.
- `workspace.backend: http` continues to work — operators can have `gitServer.experimental.gitProtocol=true` (StatefulSet renders for testing) while still routing host traffic to the legacy `Deployment`. Useful during canary preflight.

The chart render tests (`packages/chart-tests/`) get new assertions:
- `workspace.backend=git-protocol` + both toggles on → host pod has `AX_WORKSPACE_GIT_SERVER_*` env vars; no `AX_WORKSPACE_GIT_HTTP_*`.
- `workspace.backend=git-protocol` + toggles off → chart fails to render (loud error).
- `workspace.backend=http` + `gitServer.experimental.gitProtocol=true` → host pod still gets `AX_WORKSPACE_GIT_HTTP_*` (legacy path), STS renders alongside (parallel for canary preflight).

---

## Test strategy

### Package-level tests

#### `__tests__/contract.test.ts` (UPDATED)

Replace the test-only adapter with the production factory. The test-only adapter stays available for scenarios that need a per-test workspaceId.

```ts
runWorkspaceContract('@ax/workspace-git-server (production factory)', () =>
  createWorkspaceGitServerPluginForTest({
    boot: async () => {
      const server = await createWorkspaceGitServer({ ... });
      return { baseUrl, token, workspaceIdOverride: 'ws-contract-test' };
    },
  }),
);

runWorkspaceContract('@ax/workspace-git-server (test-only adapter)', () =>
  createTestOnlyGitServerPlugin({ ... }),  // Phase 1 shape, retained
);
```

Both runs assert the same 9 contract assertions. Two runs prove neither factory drifted from the other.

`createWorkspaceGitServerPluginForTest` is an `@internal` factory wrapping the production one with the test-only `urlFor` + `workspaceIdFor` overrides — never exported from `index.ts`.

#### `__tests__/multi-replica.test.ts` (NEW)

Mirror `workspace-git-http/src/__tests__/multi-replica.test.ts`'s shape. Three production-factory plugin instances (separate harnesses, separate buses), all configured with the same `workspaceIdFor` override returning a fixed test ID. They race on `parent: v0`; exactly one wins per round; losers retry via `cause.actualParent`; final list shows linear history with all changes.

This proves the multi-replica story works against the new tier — same property `workspace-git-http` proved against the legacy tier.

#### `__tests__/subscriber-no-leak.test.ts` (NEW)

Boundary review enforcement (per Phase 1 PR body's call-out). A plugin subscribes to a hook that delivers `WorkspaceDelta` and asserts:
- `delta.before` and `delta.after` are `WorkspaceVersion`-branded — not raw oid strings escaping the brand.
- The shape of `delta.changes[].path` is generic — no git vocabulary.

Today there's no `workspace:applied` hook (that lands in Phase 3). For Phase 2, we test the shape returned from `workspace:apply` directly: build a deep snapshot of the response and assert it contains zero string fields shaped like a 40-char hex SHA outside the `before`/`after` opaque tokens. (Practical implementation: call `workspace:apply`, then `JSON.stringify(response.delta)` and grep the result for `/^[a-f0-9]{40}$/m` outside the `before`/`after` lines. If found, fail.)

#### `client/__tests__/workspace-id.test.ts` (NEW)

- Determinism: 1000 calls with the same input → same output.
- Regex match: 10000 random inputs → all match `WORKSPACE_ID_REGEX`.
- Distinct: `(u1, a)` and `(u2, a)` produce different workspaceIds.
- Distinct: `(u1, a)` and `(u2, a)` produce different workspaceIds.

#### `client/__tests__/mirror-cache.test.ts` (NEW)

- Cache hit on second touch (no second `git fetch` against the storage tier).
- LRU eviction when `cacheMaxEntries` exceeded.
- `shutdown()` drains queues and removes all mirror dirs.

#### `client/__tests__/retry.test.ts` (NEW)

- Connection error retries with backoff (mock `runGit` to fail with `ECONNREFUSED` once, then succeed; assert backoff timing).
- 4xx never retries.
- Max attempts honored.

### Preset-level tests

#### `presets/k8s/src/__tests__/workspace-config.test.ts` (UPDATED or NEW)

Add cases for `AX_WORKSPACE_BACKEND=git-protocol`:
- Both `AX_WORKSPACE_GIT_SERVER_URL` + `AX_WORKSPACE_GIT_SERVER_TOKEN` present → returns `{ backend: 'git-protocol', baseUrl, token }`.
- Missing `AX_WORKSPACE_GIT_SERVER_URL` → throws with sanitized message.
- Missing `AX_WORKSPACE_GIT_SERVER_TOKEN` → throws with sanitized message.
- Token leak check: thrown error message does NOT contain the token.

#### `presets/k8s/src/__tests__/acceptance.test.ts` (UPDATED)

Add `it('git-protocol backend ... boots through and completes a chat')` parallel to the existing `local` case. Boots an in-process `@ax/workspace-git-server`, builds a `K8sPresetConfig` with `workspace: { backend: 'git-protocol', baseUrl: 'http://127.0.0.1:<bound-port>', token }`, drops legacy workspace plugins, runs through `agent:invoke` → `workspace:apply` → assert the chat completes and the chat-end recorder fires once.

### Chart-level tests

#### `packages/chart-tests/src/__tests__/workspace-backend.test.ts` (NEW or UPDATED)

- `workspace.backend=local` → host pod has `AX_WORKSPACE_ROOT`, no `AX_WORKSPACE_GIT_HTTP_*`, no `AX_WORKSPACE_GIT_SERVER_*`.
- `workspace.backend=http` + `gitServer.enabled=true` → host pod has `AX_WORKSPACE_GIT_HTTP_*`, no `AX_WORKSPACE_GIT_SERVER_*`.
- `workspace.backend=git-protocol` + `gitServer.enabled=true` + `gitServer.experimental.gitProtocol=true` → host pod has `AX_WORKSPACE_GIT_SERVER_*`, no `AX_WORKSPACE_GIT_HTTP_*`.
- `workspace.backend=git-protocol` + toggles off → `helm template` fails with sanitized error pointing to the missing toggle.

### What is NOT tested in Phase 2

- Bundle wire on sandbox-host axis (Phase 3).
- Skill validator (`workspace:pre-apply` + `@ax/validator-skill`) (Phase 3).
- Identity validator (Phase 4).
- Sandbox-side commit-author enforcement via env vars in pod templates (Phase 3).
- Re-sharding migration tooling (operational, deferred).

---

## Boundary review (per CLAUDE.md)

Phase 2 introduces no new bus hooks (the four `workspace:*` are unchanged from Phase 1's posture). It does introduce:

- **`workspaceIdFor(ctx)`** — derived from `(userId, agentId)`. Not a hook surface; an internal derivation. But it IS load-bearing for repo-naming stability: a future change (e.g., adding `agentId` rotation) would silently re-name every workspace's bare repo on the storage tier and orphan the prior state. Document this as a stable-derivation contract in the plugin's source comment with a test that pins the exact output for 5 hand-chosen `(userId, agentId)` pairs.

- **Subscriber risk on `WorkspaceDelta`**: validators in Phase 3 will subscribe to the (then-new) `workspace:pre-apply` hook with `WorkspaceDelta`-shaped payloads. Phase 2 must NOT let oid leak through `before`/`after` (they're already branded `WorkspaceVersion`, but a sloppy hydrate could pass a plain string). The new `subscriber-no-leak.test.ts` enforces this.

- **Token in env**: `AX_WORKSPACE_GIT_SERVER_TOKEN` lands in the host pod's env via Secret. Standard pattern; same posture as `AX_WORKSPACE_GIT_HTTP_TOKEN` today. No new secret-handling surface.

The four `workspace:*` hooks themselves: payload field names unchanged from Phase 1's posture (already opaque). No leaks.

---

## Security review (per `security-checklist`)

```
## Security review
- Sandbox: Phase 2 introduces a new capability on the HOST pod — process spawn scoped to the literal command 'git' with fixed-argv shape, mirroring the storage tier's spawn discipline from Phase 1. Caller never controls argv0 or flags; only repo paths and remote URLs are caller-derived (and validated against WORKSPACE_ID_REGEX before reaching argv). Locked-down env via HOST_GIT_ENV (extends Phase 1's PARANOID_GIT_ENV with author identity for commits; full env replacement, never { ...process.env, ... }). Per-workspace bare mirror cache lives in tempdir; SECURITY.md notes the mirror dirs hold only public git metadata (commits, trees, blobs synced from the storage tier — no secrets, no tokens). NetworkPolicy on the host pod permits egress to the storage tier headless service only (added in this PR). The sandbox tier is unchanged by Phase 2 — git binary in sandbox + bundle wire is Phase 3.
- Injection: Token lands in host pod via env (Secret); never logged, never appears in any error message (auditable via grep over the new code paths). REST CRUD uses the existing repo-lifecycle.ts (Phase 1) which already enforces no-token-in-error. Git smart-HTTP auth happens via `git -c http.extraHeader=Authorization: Bearer <token>`; the value is never logged by the plugin (we don't echo argv to logs). Workspace-id derivation is a SHA-256 hash, not user-controlled; even if `(userId, agentId)` were attacker-influenced (they aren't — they come from authenticated session), the derived `ws-<hex16>` always satisfies WORKSPACE_ID_REGEX. The plugin maps 4xx → PluginError with sanitized message; the `cause` field of parent-mismatch errors carries oid strings (already considered opaque tokens at the bus layer; not a leak per the boundary review).
- Supply chain: No new npm runtime deps in Phase 2. New runtime dependency: the git binary on the HOST pod (Phase 1 shipped it on the storage tier and sandbox doesn't have it yet). Pin via the host pod's base image (track in @ax/cli's container Dockerfile or wherever the host image is built); follow the same monthly + critical-CVE rebase cadence as Phase 1's storage-tier image. Existing CVE watch list (CVE-2024-32002, CVE-2024-32004) — same posture: the host plugin only fetches/pushes against trusted (token-authed) endpoints, never clones from untrusted sources; protocol.allow=never set in HOST_GIT_ENV regardless.
```

The HOST pod adding a `git` binary is the biggest new attack surface. The mitigation: every `git` invocation goes through a single `runGit(args, opts)` helper that enforces the env replacement and argv-array shape, and a lint rule on the package bans bare `spawn('git', ...)` outside that helper. Same discipline Phase 1 applied to the storage tier.

---

## Half-wired window — CLOSING

Phase 1 left the window OPEN. Phase 2 closes it.

PR description's "Half-wired window — CLOSED" section template:

```markdown
## Half-wired window — CLOSED (was OPEN at Phase 1)

- Window opened by: PR #30 (Phase 1, workspace-git-server scaffold)
- Closed by: this PR (Phase 2)
- New plugin loaded by: `@ax/preset-k8s` `createK8sPlugins(config)` when `config.workspace.backend === 'git-protocol'`
- Test/canary that reaches it:
  - `packages/workspace-git-server/src/__tests__/contract.test.ts` (production factory; 9 assertions)
  - `packages/workspace-git-server/src/__tests__/multi-replica.test.ts` (3 replicas, concurrency)
  - `packages/workspace-git-server/src/__tests__/subscriber-no-leak.test.ts` (boundary review enforcement)
  - `presets/k8s/src/__tests__/acceptance.test.ts` (`git-protocol backend boots through and completes a chat`)
  - `packages/chart-tests/src/__tests__/workspace-backend.test.ts` (chart render assertions)
- User-facing surface: `gitServer.experimental.gitProtocol` chart toggle is now load-bearing — it gates BOTH the StatefulSet (Phase 1) AND the host's plugin selection (this PR) when `workspace.backend=git-protocol`.
- Operator runbook update: `docs/runbooks/2026-05-01-workspace-git-server-canary.md` — replaces the "window OPEN" section with "Phase 2 closes the window; flipping the toggle now switches the host plugin too."
```

---

## Migration & rollback

### Migration (Phase 2 → Phase 3 → ... → Phase 5)

- **Phase 2 (this PR):** Host plugin registered; chart toggle gates host AND storage tier together. Operators flip `gitServer.experimental.gitProtocol=true` + `workspace.backend=git-protocol` to switch over. Sandbox-host wire still `FileChange[]`.
- **Phase 3:** Bundle wire on sandbox-host axis. `git status -based diff in the sandbox runner. Skill validator subscriber lands in same PR.
- **Phase 4:** Identity validator subscriber.
- **Phase 5:** Decommission `@ax/workspace-git-http`, `@ax/workspace-git`, `@ax/workspace-git-core`, the legacy `Deployment` template, the legacy `ClusterIP` Service template, the legacy single-PVC template. The legacy `helm.sh/resource-policy: keep` PVC is operator-deleted after migration confirmed.

### Rollback (post-deploy canary surfacing a problem)

- **Same-day:** flip both Helm values back:
  ```
  helm upgrade ... \
    --reuse-values \
    --set gitServer.experimental.gitProtocol=false \
    --set workspace.backend=http
  ```
  Host pod re-rolls with the legacy `AX_WORKSPACE_GIT_HTTP_*` env vars; `@ax/workspace-git-http` plugin re-registers; the legacy `Deployment` is the active storage tier again. The new StatefulSet's PVCs persist (`helm.sh/resource-policy: keep`) for forensics.
- **Data path:** No data is migrated between the legacy `http` server and the new `git-protocol` tier in this PR. If an operator deployed `git-protocol` and accumulated workspace state there, rolling back to `http` returns to the legacy server's older state. Document this in the runbook as "rollback returns to pre-canary state; new-tier accumulated work is preserved on the STS PVCs but unreachable via the legacy plugin." MVP-acceptable per design doc Q#1.

### Pre-flip checklist (operator runbook update)

Before flipping `experimental.gitProtocol` + `workspace.backend=git-protocol`:

- [ ] Verify chart renders with toggle off (no resource churn vs. legacy state).
- [ ] Verify chart renders with both toggles on (`workspace.backend=git-protocol` + `gitServer.experimental.gitProtocol=true`).
- [ ] Verify `pnpm test --filter @ax/workspace-git-server` and `pnpm test --filter @ax/preset-k8s` pass.
- [ ] `helm upgrade --dry-run` shows the expected env-var diff on the host pod.
- [ ] Have the rollback `helm upgrade` command ready to paste.
- [ ] Pick a workspace to canary (one user, one agent) — note the derived `workspaceIdFor` value so you can `kubectl exec` into the storage tier pod and inspect `<workspaceId>.git/` if needed.

---

## Bite-sized TDD tasks

Each task is 2–5 minutes. Commit per task. Order matters where it does (later tasks build on earlier ones).

### Task 1: workspaceId derivation (failing test)

**File:** `packages/workspace-git-server/src/client/__tests__/workspace-id.test.ts`

Tests:
- Determinism: `workspaceIdFor({ userId: 'u', agentId: 'a' })` returns the same value across 1000 calls.
- Regex match: 100 hand-chosen `(userId, agentId)` pairs (incl. unicode, very long, empty-ish) all produce a value matching `WORKSPACE_ID_REGEX`.
- Distinct: `(u1, a)` ≠ `(u2, a)`; `(u, a1)` ≠ `(u, a2)`.
- Pinned outputs: 5 hand-chosen `(userId, agentId)` pairs map to 5 hardcoded expected workspaceIds. (Captures derivation drift.)

Run: `pnpm test --filter @ax/workspace-git-server` → FAIL (module missing).

**Commit:** `test(workspace-git-server): workspaceId derivation spec`

### Task 2: workspaceId derivation (impl)

**File:** `packages/workspace-git-server/src/client/workspace-id.ts`

```ts
import { createHash } from 'node:crypto';

export function workspaceIdFor(ctx: { userId: string; agentId: string }): string {
  const h = createHash('sha256')
    .update(ctx.userId)
    .update('/')
    .update(ctx.agentId)
    .digest('hex');
  return `ws-${h.slice(0, 16)}`;
}
```

Run: tests pass.

**Commit:** `feat(workspace-git-server): workspaceId derivation`

### Tasks 3+4: REMOVED

Originally these added a host-side shard router. Per Q5, sharding is deferred — the plugin takes a single `baseUrl` provided by the chart's ClusterIP Service in front of the experimental StatefulSet. No host-side routing code lands in this PR. (Phase 1's `shardForWorkspace` / `shardUrl` in `src/shared/` stay in place; they're just unused by the host plugin until N>1 is needed.)

### Task 5: Retry helper (failing test)

**File:** `packages/workspace-git-server/src/client/__tests__/retry.test.ts`

Tests:
- Transient error retries with exponential backoff (mock clock).
- Non-retryable error throws immediately.
- Max attempts honored — the (N+1)th transient error throws.
- `isTransientConnectionError` recognizes ECONNREFUSED, ECONNRESET, EPIPE, ENOTFOUND, EHOSTUNREACH, ENETUNREACH, ETIMEDOUT.
- 4xx surfaced as `PluginError` is NOT retried.

**Commit:** `test(workspace-git-server): retry helper spec`

### Task 6: Retry helper impl

**File:** `packages/workspace-git-server/src/client/retry.ts`

Port the retry primitive from `@ax/workspace-git-http`'s `client.ts:278-297` (the `withRetry` closure) — extract into a standalone helper accepting `{ maxAttempts, backoffBaseMs }`. Reuse the same `TRANSIENT_ERRNOS` set and `isTransientConnectionError` predicate.

**Commit:** `feat(workspace-git-server): retry helper`

### Task 7: Mirror cache (failing test)

**File:** `packages/workspace-git-server/src/client/__tests__/mirror-cache.test.ts`

Tests:
- `acquire(workspaceId)` creates a tempdir, runs `git init --bare -b main`, returns a handle.
- Second `acquire` for the same workspaceId returns the same handle (cache hit; no new init).
- LRU eviction: 65 distinct workspaceIds with `cacheMaxEntries: 64` → first acquired is evicted (mirror dir removed).
- `shutdown()` removes ALL tempdirs.
- `acquire` is concurrency-safe: 10 simultaneous calls for the same workspaceId → exactly one mirror created.

**Commit:** `test(workspace-git-server): mirror cache spec`

### Task 8: Mirror cache impl

**File:** `packages/workspace-git-server/src/client/mirror-cache.ts`

Implements the cache as a simple Map<workspaceId, Promise<MirrorHandle>> with LRU tracked via a separate access-order array. `acquire` is idempotent within a process. `shutdown` resolves the queue tail then `rm -rf`'s every tracked mirror dir.

**Commit:** `feat(workspace-git-server): mirror cache with LRU eviction`

### Task 9: Extract `runGit` + git-engine skeleton

**File:** `packages/workspace-git-server/src/client/git-engine.ts`

Extract `runGit`, `readBlobBytes`, `globToRegex`, `diffTree`, `currentMirrorOid`, `buildScratch`, `applyChanges`, `commitScratch`, `pushScratch`, `buildDelta`, `fetchMirror`, `authConfig`, `HOST_GIT_ENV`, `AUTHOR_ENV` from `plugin-test-only.ts` verbatim (no behavior change). Same exports, same shapes.

Add a new `GitEngine` class/factory with:

```ts
interface GitEngine {
  apply(workspaceId: string, parent: WorkspaceVersion | null, changes: FileChange[], reason?: string): Promise<...>;
  read(workspaceId: string, path: string, version?: WorkspaceVersion): Promise<...>;
  list(workspaceId: string, opts: { version?, pathGlob? }): Promise<...>;
  diff(workspaceId: string, from: WorkspaceVersion | null, to: WorkspaceVersion): Promise<...>;
  shutdown(): Promise<void>;
}
```

The engine takes `{ mirrorCache, lifecycleClient, retry, baseUrl }` constructor opts. `lifecycleClient` is a single `RepoLifecycleClient` (one storage tier URL, no per-call routing). `baseUrl` is the corresponding git smart-HTTP base URL for the same storage tier. Existing serialization queue moves into the engine, keyed per workspaceId.

Tests: a thin `git-engine.test.ts` exercising one `apply` call against an in-process server with an injected `urlFor` returning the bound port. Most depth comes from the existing contract test.

**Commit:** `feat(workspace-git-server): extract GitEngine from plugin-test-only`

### Task 10: Production plugin factory (failing test)

**File:** `packages/workspace-git-server/src/client/__tests__/plugin.test.ts`

Tests against `createWorkspaceGitServerPlugin`:
- Manifest: `name: '@ax/workspace-git-server'`, `registers: ['workspace:apply', 'workspace:read', 'workspace:list', 'workspace:diff']`, `calls: []`, `subscribes: []`.
- One harness, one plugin → `workspace:apply` works end-to-end (boots in-process server via test override).
- `workspaceIdFor` derives different IDs for different `(userId, agentId)` ctxs → two ctxs in the same harness operate on two distinct workspaces (verified by reading the storage tier's `<repoRoot>/<wsId>.git` directly).
- `shutdown()` drains queues + removes mirrors (mirror dirs absent post-shutdown).

**Commit:** `test(workspace-git-server): production plugin factory spec`

### Task 11: Production plugin factory impl

**File:** `packages/workspace-git-server/src/client/plugin.ts`

```ts
export interface CreateWorkspaceGitServerPluginOptions { ... }

export function createWorkspaceGitServerPlugin(
  opts: CreateWorkspaceGitServerPluginOptions,
): Plugin {
  // Build engine with one RepoLifecycleClient + one baseUrl (no per-call routing).
  // Register four hooks; each derives workspaceId via opts.workspaceIdFor ?? workspaceIdFor.
  // Implement shutdown.
}
```

The factory wires `MirrorCache` + `GitEngine` + workspace-id derivation. (Sharding deferred per Q5; one storage tier URL per plugin instance.)

**Commit:** `feat(workspace-git-server): production plugin factory`

### Task 12: Refactor `plugin-test-only.ts` to use the new engine

**File:** `packages/workspace-git-server/src/client/plugin.ts` (consolidate)

Move `createTestOnlyGitServerPlugin` into the same file. It now wraps a `GitEngine` configured with:
- A fixed workspaceId from `boot()`.
- The single `baseUrl` from `boot()`.

Delete `plugin-test-only.ts`. Update `index.ts` to re-export both factories.

Run `pnpm test --filter @ax/workspace-git-server` — all Phase 1 tests still pass against the test-only factory (proves the refactor is behavior-preserving).

**Commit:** `refactor(workspace-git-server): fold plugin-test-only into shared engine`

### Task 13: Subscriber-no-leak boundary test

**File:** `packages/workspace-git-server/src/__tests__/subscriber-no-leak.test.ts`

Test: subscribe a no-op subscriber to `workspace:apply`'s output indirectly by inspecting the response. Assertions:
- `JSON.stringify(response.delta).match(/\b[a-f0-9]{40}\b/g)` returns AT MOST 2 matches (the `before` and `after` opaque tokens).
- The 40-hex matches all appear adjacent to the keys `before` or `after` in the JSON (i.e., not in any `path`, `kind`, or `reason` field).
- For a `parent: null` initial apply, `delta.before === null` → at most 1 match.

If a future hydrator accidentally serializes oid into a field, the test fails loudly.

**Commit:** `test(workspace-git-server): subscriber boundary leak detection`

### Task 14: Multi-replica concurrency test

**File:** `packages/workspace-git-server/src/__tests__/multi-replica.test.ts`

Mirror `workspace-git-http/src/__tests__/multi-replica.test.ts`'s shape. Three production-factory plugin instances (separate harnesses + buses) all configured with a `workspaceIdFor` override returning the same fixed `ws-multi-test`. They race on `parent: v0`; assert exactly one wins per round; losers retry via `cause.actualParent`; final list reflects all changes; history is linear.

**Commit:** `test(workspace-git-server): multi-replica concurrency`

### Task 15: Update package contract test to use both factories

**File:** `packages/workspace-git-server/src/__tests__/contract.test.ts`

Add a second `runWorkspaceContract` invocation against the production factory with a thin test-only adapter (`createWorkspaceGitServerPluginForTest`) that supplies a `urlFor` override + a `workspaceIdFor` override returning a fresh ID per scenario.

Both runs (test-only and production) pass the 9 contract assertions.

**Commit:** `test(workspace-git-server): contract test against production factory`

### Task 16: K8sWorkspaceConfig + workspaceConfigFromEnv extension (failing test)

**File:** `presets/k8s/src/__tests__/workspace-config.test.ts` (or wherever the existing tests live)

New test cases:
- `AX_WORKSPACE_BACKEND=git-protocol` + `AX_WORKSPACE_GIT_SERVER_URL` + `AX_WORKSPACE_GIT_SERVER_TOKEN` → returns `{ backend: 'git-protocol', baseUrl, token }`.
- Missing `AX_WORKSPACE_GIT_SERVER_URL` → throws with sanitized message.
- Missing `AX_WORKSPACE_GIT_SERVER_TOKEN` → throws with sanitized message.
- Token never appears in any thrown error message.

Run: tests fail (env loader doesn't recognize `git-protocol`).

**Commit:** `test(preset-k8s): git-protocol workspace config spec`

### Task 17: K8sWorkspaceConfig + workspaceConfigFromEnv impl

**Files:** `presets/k8s/src/index.ts`

- Extend the `K8sWorkspaceConfig` discriminated union with the third arm.
- Add the `git-protocol` branch to `workspaceConfigFromEnv`.
- Add the `git-protocol` branch to `createK8sPlugins` — `plugins.push(createWorkspaceGitServerPlugin({...}))`.
- Add `@ax/workspace-git-server` to package.json dependencies.

Run: env-loader tests pass.

**Commit:** `feat(preset-k8s): git-protocol workspace backend`

### Task 18: Acceptance test for git-protocol backend

**File:** `presets/k8s/src/__tests__/acceptance.test.ts`

Add `it('git-protocol backend boots and completes a chat')` parallel to the existing `local` case:
- Boots an in-process `@ax/workspace-git-server` on a tempdir repoRoot.
- Builds `K8sPresetConfig` with `workspace: { backend: 'git-protocol', baseUrl: 'http://127.0.0.1:<bound-port>', token }`.
- Drops legacy plugins from kept set (different `PLUGINS_TO_DROP` for this case).
- Asserts the chat completes and chat-end recorder fires once.

**Commit:** `test(preset-k8s): acceptance — git-protocol backend chat path`

### Task 19: Helm chart — values.yaml extension

**File:** `deploy/charts/ax-next/values.yaml`

- Update the `workspace` comment block (line 75–87) to document the third value `git-protocol`.
- Add a NOTE: "When `backend: git-protocol`, set `gitServer.enabled=true` AND `gitServer.experimental.gitProtocol=true`. The chart fails to render otherwise."

**Commit:** `feat(chart): document workspace.backend=git-protocol`

### Task 20: Helm chart — experimental ClusterIP Service + host deployment env-var branch

**Files:**
- Create: `deploy/charts/ax-next/templates/git-server/service-experimental.yaml` — a regular ClusterIP `Service` (gated on `gitServer.enabled` AND `gitServer.experimental.gitProtocol`) that fronts the experimental StatefulSet pods. Same selector labels as `service-headless.yaml` and the StatefulSet, but `clusterIP: <auto>` and a stable DNS name. This is the URL the host plugin will hit.
- Modify: `deploy/charts/ax-next/templates/_helpers.tpl` — add `ax-next.gitServerExperimentalServiceUrl` returning `http://<svc-name>.<ns>.svc.cluster.local:<port>` for the new ClusterIP Service.
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml` — add the `git-protocol` branch to the env block (`AX_WORKSPACE_GIT_SERVER_URL` from the new helper, `AX_WORKSPACE_GIT_SERVER_TOKEN` from the existing `gitServerAuthSecretName` secret). Keep the existing `local` and `http` branches unchanged.

**Commits:**
- `feat(chart): experimental ClusterIP Service for sharded git-server tier`
- `feat(chart): host pod env vars for workspace.backend=git-protocol`

### Task 21: Helm chart — render assertions for the new path

**File:** `packages/chart-tests/src/__tests__/workspace-backend.test.ts` (NEW or existing extended)

Cases per the test strategy section:
- `backend=local` → only `AX_WORKSPACE_ROOT`.
- `backend=http` + gitServer.enabled → `AX_WORKSPACE_GIT_HTTP_*`.
- `backend=git-protocol` + both toggles on → `AX_WORKSPACE_GIT_SERVER_URL` + `AX_WORKSPACE_GIT_SERVER_TOKEN`, no `AX_WORKSPACE_GIT_HTTP_*`, STS + experimental ClusterIP Service render.
- `backend=git-protocol` + toggles off → render fails with sanitized error pointing to the missing toggle.
- `backend=http` + `experimental.gitProtocol=true` → host gets HTTP env vars (legacy path), STS + experimental ClusterIP Service still render alongside.

**Commit:** `test(chart): workspace.backend=git-protocol render assertions`

### Task 22: Helm chart — guardrails for misconfigured combos

**File:** `deploy/charts/ax-next/templates/_helpers.tpl` + a small `templates/_validate.tpl` file (or `NOTES.txt` if you'd rather warn-not-fail)

Add a `fail`-emitting helper invoked from `host/deployment.yaml` (or another always-rendered template) that fails `helm template` if `backend: git-protocol` is set without both toggles on.

**Commit:** `feat(chart): validate workspace.backend=git-protocol prerequisites`

### Task 23: SECURITY.md update

**File:** `packages/workspace-git-server/SECURITY.md`

Append a Phase 2 section walking the host-pod capability budget (git binary spawn, network egress to storage tier, mirror cache in tempdir). Note the host-pod base image's git pin discipline.

**Commit:** `docs(workspace-git-server): SECURITY.md Phase 2 host-pod capability budget`

### Task 24: Operator runbook update

**File:** `docs/runbooks/2026-05-01-workspace-git-server-canary.md`

Replace "Phase 1 ships server only; window OPEN" with "Phase 2 closes the window. Flipping `gitServer.experimental.gitProtocol=true` AND `workspace.backend=git-protocol` switches the host plugin too."

Add the pre-flip checklist verbatim from the migration section above.

**Commit:** `docs(runbook): Phase 2 closes the half-wired window`

### Task 25: PR description

**File:** `docs/plans/2026-05-01-workspace-redesign-phase-2-pr-body.md`

Compose against the half-wired-window-CLOSED template. Include open-question resolutions, boundary review, security review, migration & rollback. Mirror Phase 1's PR body shape.

**Commit:** None (PR body, not a commit). Open the PR.

---

## What I want from you before I start

Six sign-offs:

1. **Q1 (plugin location).** Same package (`@ax/workspace-git-server/src/client/plugin.ts`) — recommended. OK?
2. **Q2 (workspaceId derivation).** SHA-256 first 16 hex of `(userId, agentId)`, prefixed `ws-` — recommended. OK?
3. **Q3 (mirror cache lifetime).** Per-plugin-instance with LRU (default 64 entries) — recommended. OK?
4. **Q4 (retry policy).** Mirror `workspace-git-http`'s shape; outer-op retry only; no nested git-internal retries — recommended. OK?
5. **Q5 (canary surface).** Global toggle only (no per-team A/B for MVP) — recommended. OK?
6. **Q6 (acceptance test).** Add parallel `it('git-protocol backend boots ...')` in preset-k8s acceptance — recommended. OK?

After those, I'll start at Task 1.
