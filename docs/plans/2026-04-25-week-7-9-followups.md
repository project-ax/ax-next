# Week 7–9 follow-ups — what we deferred and how to pick it up

**Date:** 2026-04-25
**For:** anyone picking up follow-up work after PR #9 (Week 7–9 — production deployment shape) merges.

This doc is the single canonical index of everything Week 7–9 deferred. Each entry has enough context — file pointers, why we deferred, acceptance criteria, security concerns to think about — that the next session can pick it up cold.

Items are grouped by size: **substantial** (deserves its own handoff doc when picked up), **medium** (one-paragraph design note here is enough), **trivial** (a code TODO is the whole spec).

---

## Substantial follow-ups

These each deserve a dedicated handoff doc when someone picks them up, modeled on `docs/plans/2026-04-23-week-7-9-handoff.md`. The summaries below are the kickoff notes — they're not a substitute for the full handoff.

### 1. HTTP runner-IPC client + pod-side HTTP server

**Handoff:** [`2026-04-25-http-runner-ipc-handoff.md`](./2026-04-25-http-runner-ipc-handoff.md) — read it first when picking this up.

**Status:** the largest deferred chunk. Without this, kind/cluster acceptance can't drive a chat end-to-end — the runner pod gets created, the host's IPC client tries to connect, and `@ax/agent-runner-core/src/ipc-client.ts` throws `HostUnavailableError("not implemented yet (Task 14 deliverable)")` on the `http:` branch. Documented as a known limit in `packages/sandbox-k8s/SECURITY.md` and `deploy/MANUAL-ACCEPTANCE.md`.

**What needs to ship:**

- **Host-side HTTP IPC client.** Extend `@ax/agent-runner-core/src/ipc-client.ts`'s `parseRunnerEndpoint` so the `http:` scheme returns a working client (today it constructs a "deferred" branch that throws on use). The `unix:` branch is the reference shape — same dispatcher contract (`{action, payload}` request, `{status, body}` response), same Zod-schema validation, same per-action timeout map from `@ax/ipc-protocol/src/timeouts.ts`. Use Node `http.request` (no Express, no fetch — match the dispatcher's framework-free style).
- **Pod-side HTTP server.** A new `@ax/ipc-http` package that mirrors `@ax/ipc-server` but listens on TCP `0.0.0.0:7777` instead of a Unix socket. The dispatcher (`packages/ipc-server/src/dispatcher.ts`) is already framework-free and shape-compatible — factor it into something reusable, or just let `@ax/ipc-http` import it from `@ax/ipc-server` (this is one of the rare cases where a sibling-plugin runtime import might be justified — the dispatcher logic genuinely shouldn't be duplicated; but check if it can move to `@ax/core` instead, which is the clean answer).
- **Runner-side wiring.** Both runners (`@ax/agent-native-runner`, `@ax/agent-claude-sdk-runner`) need to start the HTTP server when `AX_RUNNER_ENDPOINT` is `http://...`. Today they spawn a Unix socket listener via `@ax/ipc-server`; mirror the choice based on URI scheme.
- **`@ax/sandbox-k8s` updates.** Today `runnerEndpoint` is `http://${pod.status.podIP}:7777`. The pod IP returns from `waitForPodReady` (`packages/sandbox-k8s/src/open-session.ts:234`). Verify the pod's containerPort 7777 is reachable from the host pod (NetworkPolicy in `deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml` already allows it).
- **Auth.** The host connects to a runner pod over HTTP — what stops a malicious pod from connecting back? `AX_AUTH_TOKEN` is already in the runner's env (Task 14 wires it through). The HTTP client must send it as a header (e.g., `Authorization: Bearer ${token}`); the HTTP server validates it on every request. Use `crypto.timingSafeEqual` for the comparison. **This is the security gate** — without it, any pod-network attacker can talk to any runner.
- **TLS.** Open question. Two options: (a) plain HTTP within the cluster with NetworkPolicy as the perimeter — same posture as legacy. (b) mTLS with a CA managed by the host pod. Recommend (a) for the first impl; (b) is a security upgrade with real complexity (cert rotation, CA bootstrapping). Document the choice in the new SECURITY.md.

**Acceptance criteria:**
- `pnpm test` still green (existing tests don't regress on the rename).
- New tests in `@ax/ipc-http` covering: route dispatch, auth header check, malformed requests → 400, missing auth → 401, timeout enforcement.
- New test in `@ax/agent-runner-core/src/__tests__/ipc-client.test.ts` for the `http:` branch — round-trip a simple action against an in-process HTTP server.
- `deploy/MANUAL-ACCEPTANCE.md`'s "chat returns a response" criterion can finally be checked off on a kind cluster.

**Security walk:** required. New `@ax/ipc-http/SECURITY.md`. The new capability is "host pod opens TCP connections to runner pods on port 7777 with bearer auth." Walk all three threat models. Worth flagging: this is the first plugin in the codebase that opens an inbound HTTP listener on a network port — most security review attention should land here.

**Estimated size:** medium-large slice. ~600–1000 LOC of impl + tests + SECURITY.md. Probably 1–2 days of focused work. The runner-side `@ax/ipc-server`/dispatcher rework might balloon if the dispatcher is hard to factor cleanly — read it first.

---

### 2. `@ax/workspace-git-http` — multi-replica workspace

**Handoff:** [`2026-04-25-workspace-git-http-handoff.md`](./2026-04-25-workspace-git-http-handoff.md) — read it first when picking this up. Don't start until #1 is merged (multi-replica acceptance depends on HTTP IPC).

**Status:** named in architecture doc Section 4 (line 162) and Section 4 "The git-server case" (line 180). Handoff scope decision 2 explicitly recommended deferring to Week 10+. The single-replica `@ax/workspace-git` we shipped uses an in-process Mutex for parent-version CAS, which only works because there's exactly one writer per pod's PVC.

**What needs to ship:**

- **`@ax/workspace-git-http` plugin.** Same hook contract as `@ax/workspace-git` (`workspace:apply` / `read` / `list` / `diff`) — the whole point is that subscribers don't change. Internally it talks to a separate git-server pod over HTTP (or git smart protocol — TBD).
- **Git-server pod.** Separate container in the Helm chart. Legacy used a stock `git-http-backend` setup; we can do the same or run our own thin HTTP server. The pod owns the bare repo on a PVC; all host replicas talk to it.
- **Atomic ref updates across replicas.** This is the hard part. `git update-ref` with expected-old-sha gives us atomic CAS at the git-server pod boundary; the in-process Mutex from `@ax/workspace-git` becomes irrelevant. Verify behavior under concurrent `apply` from N replicas — pick one to land, the others get `parent-mismatch` and retry.
- **Helm chart additions.** Re-add the `git-server-deployment.yaml`, `git-server-service.yaml`, `git-server-pvc.yaml` templates that we deliberately didn't port from legacy in Task 19. NetworkPolicy: host pod can reach git-server; runner pods cannot (they go through the host).
- **Multi-replica host Deployment.** `replicas: 1` in `deploy/charts/ax-next/values.yaml` becomes configurable. Add HPA + PDB at the same time (related deferral below).

**Acceptance criteria:**
- The `runWorkspaceContract` shared test suite passes against `@ax/workspace-git-http` — same 9 assertions, no contract changes. This is the I1 proof.
- A multi-replica acceptance test that has 3 host replicas applying concurrent commits; assert N-1 get `parent-mismatch` and successfully retry; final state is a linear history with all changes.

**Security walk:** required. The git-server pod is a new network endpoint; its RBAC + NetworkPolicy must be tight (only host pods can reach it). Authentication between host pods and git-server pod — same question as #1 (TLS or not). New SECURITY.md for `@ax/workspace-git-http` + an update to `deploy/charts/ax-next/SECURITY.md` for the new pod.

**Estimated size:** large slice. The contract test suite carries; the network/HA logic is the work. Probably 2–3 days. Wait until multi-replica is actually needed (real load on a real cluster) — otherwise this is YAGNI.

---

### 3. Kernel shutdown lifecycle

**Handoff:** [`2026-04-25-kernel-shutdown-handoff.md`](./2026-04-25-kernel-shutdown-handoff.md) — read it first when picking this up. Independent of #1 and #2.

**Status:** pre-existing TODO across the codebase. Affects:
- `packages/storage-sqlite/src/plugin.ts` — `// TODO(kernel-shutdown):` comment block; better-sqlite3 file handle leaks on process exit (acceptable for one-shot CLI runs only).
- `packages/database-postgres/src/plugin.ts` — same TODO; pg.Pool not drained on shutdown.
- `packages/eventbus-postgres/src/plugin.ts` — already exposes a `shutdown()` test escape hatch (lines 53–61) explicitly TODO'd against the kernel shutdown landing.
- `packages/session-postgres/src/plugin.ts` — same situation.
- `packages/sandbox-k8s/src/plugin.ts` — k8s API client uses Node's default keep-alive HTTP agent; clean shutdown should `agent.destroy()`.
- Any future plugin with long-lived connections.

**What needs to ship:**

- **`Plugin.shutdown?(): Promise<void>`** added to the `Plugin` type in `@ax/core`. Optional — plugins without resources to clean up don't have to implement it.
- **Kernel orchestration.** The kernel calls `shutdown()` in reverse-load order on SIGINT/SIGTERM, with a per-plugin timeout (e.g., 10s) so a misbehaving plugin can't block process exit forever. Plugins that throw or time out get their failure logged but don't block other shutdowns.
- **Update existing plugins.** Drop all the TODO comments; implement `shutdown()` on every plugin holding resources (storage-sqlite's Database, database-postgres's Pool, eventbus-postgres's Client, session-postgres's Pool + Client, sandbox-k8s's HTTP agent).
- **`@ax/eventbus-postgres`** can drop its public `shutdown()` test escape hatch — tests should call it via the kernel instead.

**Acceptance criteria:**
- A new test in `@ax/core` exercises shutdown ordering (load 3 plugins, shut down, assert reverse order + that a throwing plugin doesn't block the others).
- All `TODO(kernel-shutdown):` comments are deleted.
- Process can SIGTERM cleanly without leaving zombie connections (verify with `lsof` on a kind cluster after a kill).

**Security walk:** N/A — this is an internal lifecycle concern, no new capability surface.

**Estimated size:** small-medium. Maybe 1 day. The orchestration is straightforward; the time goes into auditing every plugin and writing the per-plugin `shutdown()`.

---

## Medium follow-ups

These are too big for a TODO comment but don't merit a full handoff doc. A paragraph here is the spec.

### 4. `Dockerfile.agent` for the runner pod image

The Helm chart in `deploy/charts/ax-next/` consumes a pre-built image (`image.repository` + `image.tag` in `values.yaml`). We didn't ship the Dockerfile to build it — `deploy/README.md` has a `# TODO(deploy)` note on this.

**What it needs:**
- Multi-stage Dockerfile under `deploy/Dockerfile.agent`. Stage 1: build the monorepo with pnpm. Stage 2: copy `dist/` for both runner binaries (`@ax/agent-native-runner` and `@ax/agent-claude-sdk-runner`) plus their transitive runtime deps. Stage 3: a slim Node runtime image (e.g., `node:22-alpine` or `gcr.io/distroless/nodejs22`) with the binaries at known absolute paths (e.g., `/opt/ax-next/runners/native.js` and `/opt/ax-next/runners/claude-sdk.js`).
- Image must be **gvisor-compatible** — Alpine works; distroless works; full glibc is fine. The pod spec runs as UID 1000, so the image must have a non-root user at that UID (or we relax UID to whatever the image provides — but then the Helm chart's `securityContext.runAsUser: 1000` needs to match).
- README update with the build command + how to push it.
- The `runnerBinary` value the host passes to `sandbox:open-session` becomes a known absolute path inside the image — wire it via Helm chart values so the host's chat-orchestrator config matches what the image actually contains.

**Why not in Week 7–9:** building the runner image is a build/release concern, not a chart concern. We could've shipped it but it would've added a Docker dependency to the slice, and the kind acceptance test was already deferred for the HTTP IPC reason.

---

### 5. Wire `@ax/workspace-git` into `@ax/preset-local`

Currently `packages/cli/src/main.ts` (the local preset) does not register a workspace plugin. Task 7c made empty-turn `workspace.commit-notify` calls skip the wire as a workaround — without that, the cli e2e test sees `no service registered for 'workspace:apply'` errors leaking into stdout.

**What it needs:**
- Add `createWorkspaceGitPlugin({ repoRoot: <local-path> })` to the cli's plugin list. Default `repoRoot` to something like `~/.ax-next/workspaces/${sessionId}` or a configurable path in `ax.config.ts`.
- Drop the empty-turn skip in `packages/agent-native-runner/src/turn-loop.ts:115-119` and `packages/agent-claude-sdk-runner/src/main.ts:175-179` once the local preset has a workspace plugin — empty turns can then send the no-op commit-notify cleanly.
- Update the cli e2e test to verify a workspace version is minted after a local chat (mirrors the k8s acceptance test's workspace assertion).

**Why not in Week 7–9:** out of scope for the k8s slice (workspace-git was the *production* workspace; local mode used in-memory). The skip workaround was the path of least resistance to keep the cli e2e green.

---

## Trivial follow-ups

These are small enough that a code TODO captures the whole spec.

### 6. `@ax/session-postgres` LISTEN reconnect-with-backoff

The LISTEN client in `packages/session-postgres/src/inbox.ts` doesn't have the reconnect-with-backoff that `@ax/eventbus-postgres` ships in `packages/eventbus-postgres/src/listener.ts`. On a postgres restart, in-flight blocked claims fall through to their `timeoutMs` rather than waking on the new NOTIFY.

**Fix:** lift the `Listener` pattern from `eventbus-postgres/src/listener.ts` into a shared internal helper or duplicate it in session-postgres. Same backoff sequence (1s → 30s ceiling), same `unref()` pattern, same shutdown handling.

**Add this TODO** in `packages/session-postgres/src/inbox.ts` at the listener init site so this doesn't get lost.

### 7. `@ax/session-postgres/SECURITY.md`

Plan oversight — Task 11 covered the database/storage/eventbus trio, but session-postgres came in Task 12 and didn't get its own SECURITY.md. Same template as the others (~80 lines):
- Sandbox: own pg.Pool + dedicated LISTEN client; channel-name allowlist; `pg.escapeIdentifier`; `pg_notify($1,$2)` parameter binding.
- Injection: session tokens are minted server-side (`randomBytes(32).toString('base64url')`), never agent-supplied. Token comparison should be `crypto.timingSafeEqual`-based on `resolve-token` (verify in code; if not, also a follow-up).
- Supply chain: `kysely` + `pg` already covered by database-postgres's review.

Also include the LISTEN reconnect gap (#6) under "Known limits."

### 8. `kubeconform` / `kubeval` in CI

`deploy/charts/ax-next/SECURITY.md` and `deploy/README.md` both flag this as a follow-up. Add a CI step that runs `helm template` and pipes through `kubeconform -strict`. Catches chart drift early. One-line GitHub Actions addition.

### 9. HPA + PDB + multi-replica host

Currently `replicas: 1` is hard-coded in `deploy/charts/ax-next/values.yaml`. When `@ax/workspace-git-http` (#2 above) lands, this becomes configurable, and a `HorizontalPodAutoscaler` + `PodDisruptionBudget` template should land alongside. Don't ship HPA before multi-replica works — that just means the second replica fails on workspace conflicts.

### 10. Web proxy (egress proxy for runner pods)

Architecture doc Section 4 references this; legacy v1 had it. Runner pods should reach approved external domains (Anthropic API, MCP servers) only through a proxy on the host pod, not directly. Currently runner pods have no egress (NetworkPolicy denies it), which works for built-in tools but blocks any tool that needs the network. Week 10+ scope per the original plan.

---

## How to use this doc

When picking up any of the above:

1. **Substantial items (1–3):** the handoff docs already exist (linked under each item above). Read the handoff first — it has the file pointers, the architecture decisions that have been resolved, and the kickoff prompt for `/clear` + `superpowers:writing-plans`. If a follow-up that doesn't yet have a handoff lands here later, write one modeled on `2026-04-23-week-7-9-handoff.md`.
2. **Medium items (4–5):** the paragraph here might be enough — go straight to a plan or just implement if it's clear.
3. **Trivial items (6–10):** just do them. Many will land naturally as part of other slices.

Update this doc when items land. Each completed item gets struck through with a link to the PR.

## Items that are NOT here (intentional)

These are out of scope by architecture, not by deferral:

- Anything in **Week 9.5** (multi-tenant: auth, agents, http-server, admin UI). Has its own handoff: `docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md`.
- Anything in **Week 10–12** (channels + observability). Has its own handoff: `docs/plans/2026-04-23-week-10-12-handoff.md`.
- Anything in **Week 13+** (memory-strata, additive workspace backends like GCS, scheduler). Has its own handoff: `docs/plans/2026-04-23-week-13-plus-handoff.md`.

If a follow-up here turns out to belong in one of those slices, move it there and link from this doc.
