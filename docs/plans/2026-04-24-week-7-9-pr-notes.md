# Week 7–9 — Production Deployment Shape (PR notes)

**Branch:** `feat/week-7-9-k8s-deployment`
**Base:** `main` @ `0959a2d` (tip of 6.5e)
**Plan:** [`docs/plans/2026-04-24-week-7-9-k8s-deployment.md`](2026-04-24-week-7-9-k8s-deployment.md)
**Handoff:** [`docs/plans/2026-04-23-week-7-9-handoff.md`](2026-04-23-week-7-9-handoff.md)

---

## Summary

Week 7–9 swaps the single-host plugins shipped in earlier slices for their
production-shape equivalents behind the same hook surfaces. This is the slice
where Invariant 1 ("hook surface is transport-/storage-agnostic") earns its
keep — we ship a postgres + k8s + git-backed plugin set against subscriber
contracts that haven't moved an inch since Week 4–6, and a `MockWorkspace` ↔
`@ax/workspace-git` shared contract test suite proves the workspace abstraction
in Section 4.5 is genuinely backend-shape-neutral.

Eight new plugins, the workspace contract in `@ax/core`, the `@ax/preset-k8s`
meta-package, and a Helm chart ported from legacy. `pnpm test` is green (708
tests across 24 packages + 1 preset).

---

## Five-invariant audit

| Invariant | Status | Evidence |
|---|---|---|
| **I1** — transport-/storage-agnostic hooks | ✅ | `packages/test-harness/src/workspace-contract.ts` runs identical 9-assertion suite against both `MockWorkspace` (versions like `mock-N`, no SHA shape) and `@ax/workspace-git` (versions are commit SHAs) — proves no git vocab leaks into payload field names. `socketPath → runnerEndpoint` rename (commit `16bb1f4`) cleans up the I1 violation 6.5a introduced before k8s was on the table. |
| **I2** — no cross-plugin imports | ✅ | All new plugins depend on `@ax/core` + third-party deps only. Storage-postgres reaches Kysely via `bus.call('database:get-instance')`; eventbus-postgres + session-postgres take their own `connectionString` because LISTEN can't share a pool (documented precedent). Confirmed via `grep -rn "from '@ax/" packages/{database-postgres,storage-postgres,eventbus-postgres,session-postgres,workspace-git,sandbox-k8s}/src/` — only `@ax/core`. |
| **I3** — no half-wired plugins | ✅ | Every new plugin is loaded by `@ax/preset-k8s` (`presets/k8s/src/index.ts`). Real exercise: postgres trio via testcontainers in their own suites; `@ax/preset-k8s` acceptance test (`presets/k8s/src/__tests__/acceptance.test.ts`) drives storage / eventbus / session / workspace through the bus end-to-end against a real `postgres:16-alpine` container. `@ax/preset-local` regression — `pnpm --filter @ax/cli test` 41/41 green after Phase B landed. |
| **I4** — one source of truth per concept | ✅ | `WorkspaceVersion` brand declared once in `@ax/core` (`packages/core/src/workspace.ts`), re-exported from `@ax/ipc-protocol` for compat. Postgres tables use per-plugin prefixes (`storage_postgres_v1_*`, `session_postgres_v1_*`); no cross-plugin foreign keys (defensive comment in `session-postgres/src/migrations.ts`). The wiring smoke test (`presets/k8s/src/__tests__/preset.test.ts`) catches duplicate service-hook registrants at compose time. |
| **I5** — capabilities explicit and minimized | ✅ | sandbox-k8s pod defaults are locked down: `runtimeClassName=gvisor`, `automountServiceAccountToken=false`, `runAsNonRoot=true`, `allowPrivilegeEscalation=false`, `capabilities.drop=['ALL']`, `readOnlyRootFilesystem=true` + emptyDir mounts, resource limits, `activeDeadlineSeconds=3600`. Host pod RBAC is the minimum five `pods` verbs (`pods: create/delete/get/list/watch`) — no `pods/exec`, no `pods/attach`, no cluster-scoped verbs. eventbus-postgres channel-name allowlist + `pg.escapeIdentifier` + `pg_notify($1,$2)` parameter binding + 8000-byte payload cap. workspace-git path validation rejects `..`/absolute/NUL/`.git/` segments via the legacy `safePath` helper ported into `@ax/core`. |

---

## Boundary review

- **Alternate impl for `workspace:apply` / `read` / `list` / `diff`:** `@ax/workspace-gcs` (manifest-object pattern, Section 4.5) and `@ax/workspace-s3` are the obvious candidates. The contract test-suite (`runWorkspaceContract`) is precisely the suite they will be required to pass.
- **Alternate impl for `database:get-instance`:** a future `@ax/database-mysql` or `@ax/database-cockroach` would register the same hook returning a Kysely instance for that dialect.
- **Alternate impl for `eventbus:emit` / `subscribe`:** `@ax/eventbus-inprocess` (this slice) and `@ax/eventbus-postgres` (this slice) are the two impls that validate the contract on day one. A future redis/nats impl would slot in identically.
- **Alternate impl for `sandbox:open-session`:** `@ax/sandbox-subprocess` (already shipped) and `@ax/sandbox-k8s` (this slice). Future firecracker impl would register the same hook.
- **Payload field names that might leak:** none. `parentVersion`/`version` are already in IPC protocol from 6.5a; we keep them. `runnerEndpoint` is now an opaque URI (was `socketPath`). `commitRef` survives in the wire schema as the runner's opaque local identifier — host doesn't dispatch on it; the `changes` array IS the source of truth.
- **Subscriber risk:** `workspace:applied` will be the integration point for `@ax/scanner-canary` (Week 10–12) and `@ax/skills-validator` (Week 13+). Lazy `contentBefore`/`contentAfter` fetchers (covered by contract test) ensure subscribers that only care about specific path globs don't pay for full diff bytes.
- **Wire surface:** `workspace.commit-notify` IPC schema gains `changes: FileChange[]` (default `[]`). Backwards-compatible with runners that don't yet send a diff — they get a no-op apply. Wire response NEVER carries a delta — lazy fetchers don't serialize, exposing them widens the trust boundary.

---

## Per-package security review

Three-line summaries — full details in each `SECURITY.md`.

### `@ax/workspace-git` (`packages/workspace-git/SECURITY.md`)
- **Sandbox:** filesystem reach limited to `repoRoot/repo.git`; path validation rejects `..`/absolute/NUL/`.git/` segments at `apply` boundary; reads/lists/diffs go through `git.readBlob`/`listFiles` (no direct FS path resolution from caller-supplied strings); zero shell-out (pure `isomorphic-git`).
- **Injection:** agent-supplied `reason` flows into commit messages only — opaque to consumers; LLM-output `FileChange.content` is `Bytes`, never interpolated; bot identity (`ax-runner`) hard-coded — agent-supplied identity goes to `WorkspaceDelta.author` provenance fields, never git committer.
- **Supply chain:** `isomorphic-git@1.37.5` (pinned, no install hooks beyond a publish-time `prepublishOnly` that's irrelevant for npm registry installs) + `picomatch@4.0.4` (pinned). The `simple-get` transitive is network-capable but unreachable from our `git/http/node` non-import.

### `@ax/database-postgres` (`packages/database-postgres/SECURITY.md`)
- **Sandbox:** opens a `pg.Pool` to caller-config'd `connectionString`; pool max bounded (default 10); password never logged at info+; no FS / spawn / network beyond the configured DSN.
- **Injection:** N/A — exposes a Kysely instance; consumers parametrize their own queries (Kysely does it by default).
- **Supply chain:** `kysely@0.28.16`, `pg@8.20.0` — both pinned exactly, established maintainers, no install hooks.

### `@ax/storage-postgres` (`packages/storage-postgres/SECURITY.md`)
- **Sandbox:** reads/writes one table (`storage_postgres_v1_kv`); Kysely parametrizes; migrations are pinned literal SQL.
- **Injection:** tool/LLM output may flow into `storage:set` value bytes; stored as opaque BYTEA; never interpolated elsewhere in this plugin.
- **Supply chain:** no new direct deps beyond database-postgres's review.

### `@ax/eventbus-postgres` (`packages/eventbus-postgres/SECURITY.md`)
- **Sandbox:** dedicated `pg.Client` per instance; channel-name allowlist `/^[a-zA-Z0-9_]+$/` + `pg.escapeIdentifier` on LISTEN/UNLISTEN; `pg_notify($1,$2)` parameter-bound on emit; 8000-byte payload cap; reconnect backoff bounded 1s→30s.
- **Injection:** subscriber payloads are caller-supplied; JSON-serialized in transit; LISTEN/NOTIFY observable by any postgres role with sufficient privileges (flagged).
- **Supply chain:** direct dep `pg@8.20.0` already covered by trio review.

### `@ax/session-postgres` — no SECURITY.md yet
Walked but not committed. Same threat profile as eventbus-postgres + storage-postgres combined. Known limit: the LISTEN client lacks reconnect-with-backoff that eventbus-postgres has; on a postgres restart, in-flight blocked claims fall through to their `timeoutMs` rather than waking. **Flagged as a follow-up in this PR description and as a code TODO.**

### `@ax/sandbox-k8s` (`packages/sandbox-k8s/SECURITY.md`)
- **Sandbox:** the single biggest blast-radius surface in the slice. Pod defaults: gvisor, runAsNonRoot=true, allowPrivilegeEscalation=false, capabilities.drop=['ALL'], readOnlyRootFilesystem=true with emptyDir for /tmp + /workspace, resource limits, activeDeadlineSeconds=3600 safety net. `automountServiceAccountToken=false` — runner pods get NO k8s API access. Host pod's k8s capability is set in the Helm chart's Role — this plugin's safety story depends on that RBAC scope being minimal (cross-reference to `deploy/charts/ax-next/SECURITY.md`).
- **Injection:** pod spec built from validated config + caller-supplied (Zod-validated) `sessionId`/`runnerBinary`; LLM output never reaches `buildPodSpec`; no `process.env[userInput]`.
- **Supply chain:** `@kubernetes/client-node@1.4.0` — pinned exactly, official k8s-sigs maintainer, no install hooks (only a publish-time `prepare`). Substantial bundle (~46MB unpacked) — trade-off is hand-rolling auth/CA-bundle/proxy support is worse.

### `deploy/charts/ax-next/SECURITY.md`
- **Sandbox:** Role lists every verb with rationale (`pods: create/delete/get/list/watch` only); legacy verbs explicitly dropped (`pods/exec`, `pods/attach`, `pods/log`, `patch`); two NetworkPolicies fence runner pods + host pod with documented ingress/egress rules.
- **Injection:** N/A — manifests are static templates with no model/tool input flowing in.
- **Supply chain:** `bitnami/postgresql@16.7.27` (chart digest committed in `Chart.lock`), `Bitnami's bitnamilegacy/* migration noted, CVE check honestly flagged as "not exhaustive — re-review."

---

## Acceptance evidence

### Automated (CI)

```
$ pnpm test
... (24 packages + 1 preset, all green)
Total tests: 708
```

Highlights of this slice's contribution:
- `@ax/core` workspace contract: 4 tests + 9 safe-path tests (68 total)
- `@ax/test-harness` MockWorkspace + shared contract: 25 tests
- `@ax/eventbus-inprocess`: 3 tests
- `@ax/database-postgres`: 3 tests (testcontainers)
- `@ax/storage-postgres`: 3 tests (testcontainers)
- `@ax/eventbus-postgres`: 6 tests (testcontainers, including cross-instance NOTIFY delivery)
- `@ax/session-postgres`: 13 tests (testcontainers, including cross-instance long-poll wakeup)
- `@ax/workspace-git`: 10 tests (1 scaffold + 9 contract)
- `@ax/sandbox-k8s`: 29 tests (mocked k8s API)
- `@ax/preset-k8s`: 10 tests (5 wiring + 5 acceptance with testcontainers postgres)

The `@ax/preset-k8s` acceptance test is the integration proof: bootstraps the
full plugin chain against a real postgres container, exercises storage /
eventbus / session / workspace through the bus, asserts state lands. ~2.3s
warm, ~25–40s cold (postgres image pull).

### Manual (kind / real cluster)

See [`deploy/MANUAL-ACCEPTANCE.md`](../../deploy/MANUAL-ACCEPTANCE.md). **Honest
disclosure:** the HTTP runner-IPC client is deferred (Task 14b cut). The kind
acceptance in this slice can verify chart installs cleanly + postgres + host
pod come up + runner pod is created — but the chat itself fails at the IPC
handshake until HTTP IPC ships. We mark the chat acceptance criterion as N/A
for this slice; re-enable once the follow-up unblocks it.

---

## Scope cuts deferred to follow-up PRs

Each is called out in either code (TODO comments), docs (SECURITY.md "Known
limits" sections, MANUAL-ACCEPTANCE.md "Known gotchas"), or both.

- **HTTP runner-IPC** — `@ax/agent-runner-core/src/ipc-client.ts` `http:` branch throws `HostUnavailableError("not implemented yet")`. The runner-side HTTP server (mirror of `@ax/ipc-server` over TCP) doesn't exist yet. Substantial follow-up — multi-file but bounded.
- **`Dockerfile.agent`** — bundling both runner binaries into a container image. Build concern, not a chart concern.
- **`@ax/workspace-git-http`** — multi-replica workspace via separate git server. Single-replica only this slice.
- **Web proxy** — egress proxy for runner pods. Week 10+.
- **Admin / OAuth / agents / company-admin** — Week 9.5 multi-tenant slice.
- **`@ax/preset-local` workspace integration** — wire `@ax/workspace-git` into the local preset for parity with k8s preset. Currently the local preset doesn't register a workspace plugin.
- **`@ax/session-postgres` LISTEN reconnect-with-backoff** — eventbus-postgres has it; session-postgres LISTEN client doesn't.
- **Kernel shutdown lifecycle** — when this lands, eventbus-postgres can drop its `shutdown()` test escape hatch and database-postgres / storage-sqlite can release pools cleanly.
- **`kubeconform`/`kubeval` in CI** — would catch chart drift early. Not run locally for this PR.
- **HPA / PDB / multi-replica host** — single-replica only this slice.
- **`@ax/session-postgres/SECURITY.md`** — walked but not yet committed. Add in follow-up.

---

## Diff stats

```
139 files changed, 12746 insertions(+), 169 deletions(-)
```

Notable additions (~lines):
- Workspace contract: `packages/core/src/workspace.ts` (~80 lines), `packages/core/src/util/safe-path.ts` (~64 lines ported from legacy).
- `@ax/test-harness` MockWorkspace + shared contract: ~250 lines.
- `@ax/workspace-git`: ~600 lines impl + tests.
- `@ax/database-postgres` + `@ax/storage-postgres` + `@ax/eventbus-postgres` + `@ax/session-postgres`: ~1500 lines combined (impl + migrations + tests).
- `@ax/sandbox-k8s`: ~900 lines (impl + tests + mock API helper).
- `@ax/preset-k8s`: ~700 lines (wiring + 2 test files).
- Helm chart: ~600 lines YAML across 12 templates + values + helpers.
- 7 `SECURITY.md` files: ~1500 lines combined.
- ~2000 lines of `pnpm-lock.yaml` from new transitive deps (kysely, pg, testcontainers, isomorphic-git, picomatch, @kubernetes/client-node, @testcontainers/postgresql).

---

## Commit history

```
d7e7b3c chore: changeset for week 7-9 (k8s + postgres + workspace)
656650e docs(deploy): manual acceptance steps for kind
5a68c4e test(preset-k8s): CI acceptance — full chain end-to-end with testcontainers pg
e8f11a6 docs(deploy): SECURITY.md (security-checklist output)
f7cda29 feat(deploy): Helm chart for k8s deployment (ported from legacy)
fb89904 feat(preset-k8s): meta-package + plugin wiring
7131184 docs(sandbox-k8s): SECURITY.md (security-checklist output)
a4064fa feat(sandbox-k8s): port + adapt — open-session, pod-spec, lifecycle, idempotent kill
16bb1f4 refactor(sandbox): rename socketPath → runnerEndpoint (opaque URI)
efc0374 feat(session-postgres): port session:* hooks with LISTEN/NOTIFY long-poll
eac71f9 docs(postgres-trio): SECURITY.md for database/storage/eventbus
53e7134 feat(eventbus-postgres): LISTEN/NOTIFY pub/sub with reconnect
331f314 feat(storage-postgres): storage:get/set against postgres + per-plugin migration
7470c05 feat(database-postgres): Kysely instance factory + pg pool
e91511c feat(runners): aggregate per-turn workspace diff into single commit-notify
d28e9cd feat(ipc-server): real workspace.commit-notify wired to bus.fire/call
8a308d0 docs(workspace-git): SECURITY.md (security-checklist output)
e0a9ea5 feat(workspace-git): impl workspace:apply/read/list/diff via isomorphic-git
c0fcfd9 scaffold(workspace-git): package skeleton + isomorphic-git pin
fe0ee3d test(test-harness): shared workspace contract suite
c221c2b feat(test-harness): MockWorkspace plugin for contract validation
7843e3f feat(core): workspace contract types (Section 4.5)
c1b2b07 fix(eventbus-inprocess): remove out-of-scope validation + sequential fan-out
08f5e6f feat(eventbus-inprocess): in-process pub/sub impl
```

24 commits. Reviewable as a stack — each task lands as one or two commits.
