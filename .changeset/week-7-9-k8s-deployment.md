---
"@ax/core": patch
"@ax/ipc-protocol": patch
"@ax/ipc-server": patch
"@ax/sandbox-subprocess": patch
"@ax/agent-claude-sdk-runner": patch
"@ax/chat-orchestrator": patch
"@ax/test-harness": minor
"@ax/eventbus-inprocess": minor
"@ax/database-postgres": minor
"@ax/storage-postgres": minor
"@ax/eventbus-postgres": minor
"@ax/session-postgres": minor
"@ax/workspace-git": minor
"@ax/sandbox-k8s": minor
"@ax/preset-k8s": minor
---

Week 7–9 — production deployment shape. Swaps the single-host plugins shipped in earlier slices for their k8s-shape equivalents behind the same hook surfaces, validating Invariant 1 (transport-/storage-agnostic hooks) by shipping a postgres / k8s / git-backed plugin set against the unchanged subscriber contract.

**New plugins (8):**
- `@ax/eventbus-inprocess` (filled in skeleton) — single-host pub/sub, sequential awaited fan-out with throwing-subscriber isolation.
- `@ax/database-postgres` — singleton Kysely instance over `pg.Pool` via `database:get-instance`. Connection-string validation; pool max bounded.
- `@ax/storage-postgres` — `storage:get`/`storage:set` against postgres. Owns `storage_postgres_v1_kv` table + idempotent migration. No raw SQL.
- `@ax/eventbus-postgres` — LISTEN/NOTIFY pub/sub with channel-name allowlist, 8000-byte payload cap, exponential-backoff reconnect (1s→30s).
- `@ax/session-postgres` — five `session:*` hooks against postgres + LISTEN/NOTIFY long-poll wakeup. Initial schema is session-resolution-only (`user_id`/`agent_id` columns are Week 9.5's forward-only migration).
- `@ax/workspace-git` — first workspace backend per architecture doc Section 4.5. Bare repo at `repoRoot/repo.git`, snapshot-oriented apply/read/list/diff via `isomorphic-git@1.37.5`. CAS via per-repo Mutex. No shell-out to `git`.
- `@ax/sandbox-k8s` — pod-based sandbox. `runtimeClassName=gvisor`, `automountServiceAccountToken=false`, runAsNonRoot, capabilities drop ALL, readOnly root + emptyDir mounts, resource limits, `activeDeadlineSeconds` safety net. Per-pod child logger pre-bound with `reqId/podName/pid`. Idempotent kill (404 = success). Lifecycle reason capture (container-vs-pod-level). Bundled both runner binaries in image; config picks which.
- `@ax/preset-k8s` — meta-package + `createK8sPlugins(config)` factory. Wiring smoke tests catch duplicate registrants and unsatisfied service-hook calls at compose time.

**Workspace contract (Section 4.5):** `WorkspaceVersion` brand + lazy `() => Promise<Bytes>` fetchers + discriminated `WorkspaceReadOutput` + 8 generic service-hook payload types live in `@ax/core`. A `MockWorkspace` plugin in `@ax/test-harness` and a shared `runWorkspaceContract` test suite prove the contract is genuinely backend-shape-neutral — both `MockWorkspace` and `@ax/workspace-git` pass identical 9-assertion checks. No git vocabulary leaks into payload field names.

**Workspace IPC wired:** the 6.5a `workspace.commit-notify` stub is replaced. Wire schema gains `changes: FileChange[]` (base64-encoded `put.content`, default `[]`). Handler fires `workspace:pre-apply` (veto-capable) → `bus.call('workspace:apply')` (parent-mismatch surfaces as `accepted:false` on the wire) → `workspace:applied` host-side. Wire response NEVER carries a delta — lazy fetchers don't serialize, and exposing them widens the trust boundary.

**Per-turn diffs:** both runners (native + claude-sdk) accumulate file changes during a turn and send a single `workspace.commit-notify` at turn-end with the aggregate diff (matches MVP direction memo: turn-end commits, not per-tool-call). Empty turns skip the notify (the cli's local preset doesn't yet register a workspace plugin; sending empty notifies leaks error logs).

**`socketPath → runnerEndpoint` rename (I1 cleanup):** the `sandbox:open-session` return field is now an opaque URI (`unix:///abs/path` for subprocess; `http://podip:7777` for k8s). `AX_IPC_SOCKET` env renamed to `AX_RUNNER_ENDPOINT`. The IPC client parses the URI and switches on `.protocol`. **HTTP-scheme transport is deferred** — the `http:` branch throws `HostUnavailableError("not implemented yet")`. Documented in `packages/sandbox-k8s/SECURITY.md` and `deploy/MANUAL-ACCEPTANCE.md` as a known limit; full kind/cluster acceptance unblocks once HTTP IPC ships.

**Helm chart (`deploy/charts/ax-next/`):** ported from legacy. Single-replica host Deployment, ServiceAccount + Role + RoleBinding scoped to `pods: create/delete/get/list/watch` only (no `pods/exec`, no `pods/attach`, no cluster-scoped verbs), two NetworkPolicies fencing runner pods + host pod, embedded postgres via Bitnami subchart pinned at `bitnami/postgresql@16.7.27`, kind-friendly dev values. `Dockerfile.agent` deferred to a follow-up PR.

**Security walk (every new package):** `SECURITY.md` per package — `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/eventbus-postgres`, `@ax/session-postgres`, `@ax/workspace-git`, `@ax/sandbox-k8s`, plus `deploy/charts/ax-next/SECURITY.md`. Each walks the three threat models from the `security-checklist` skill (sandbox / injection / supply chain) with the paste-ready three-line summary at the top.

**Five-invariant audit (this slice):**
- **I1 (transport/storage-agnostic):** verified by the `MockWorkspace` ↔ `@ax/workspace-git` shared contract suite + the `socketPath → runnerEndpoint` rename. Postgres / git / k8s vocabulary stays out of payload field names.
- **I2 (no cross-plugin imports):** all new plugins depend on `@ax/core` + third-party deps only. Storage-postgres reaches Kysely via `database:get-instance` (no direct import of `@ax/database-postgres`); eventbus-postgres + session-postgres take their own `connectionString` because LISTEN can't share a pool — documented precedent.
- **I3 (no half-wired plugins):** every new plugin is loaded by `@ax/preset-k8s` and exercised by either the postgres-trio testcontainer suite or the `presets/k8s` acceptance test. The `@ax/preset-local` regression check confirms single-host mode still works.
- **I4 (one source of truth):** `WorkspaceVersion` lives in `@ax/core`; postgres tables use per-plugin prefixes (`storage_postgres_v1_*`, `session_postgres_v1_*`); no cross-plugin foreign keys; the wiring smoke test catches duplicate service-hook registrants.
- **I5 (capabilities minimized):** sandbox-k8s pod defaults are locked down (gvisor, non-root, drop ALL caps, readOnly root, automountSAToken=false, activeDeadlineSeconds, resource limits); host pod RBAC is the minimum five `pods` verbs; eventbus-postgres channel-name allowlist + payload cap; workspace-git path validation rejects `..`/absolute/NUL/`.git/` segments + reuses ported `safePath` helper.

**Test coverage:** ~80+ new tests across the 8 new plugins. `pnpm test` full repo green. `presets/k8s` acceptance test exercises postgres + workspace + session + eventbus end-to-end via the bus against a real `postgres:16-alpine` testcontainer (~25–40s cold).

**Deferred to follow-up PRs (called out in code + docs):**
- HTTP runner-IPC client + the runner pod's HTTP server (Task 14b cut). Unblocks full kind acceptance.
- `Dockerfile.agent` for the runner image.
- `@ax/workspace-git-http` for multi-replica workspace.
- Web proxy for runner egress (Week 10+).
- Admin / OAuth / agent / company-admin templates (Week 9.5).
- Wiring `@ax/workspace-git` into `@ax/preset-local` for parity with k8s preset.
- session-postgres LISTEN client lacks the reconnect-with-backoff that eventbus-postgres has — flagged for a future SECURITY.md when one's written.
- Kernel shutdown lifecycle; eventbus-postgres exposes a `shutdown()` test escape hatch as a TODO until it lands.
