# `@ax/workspace-git-http` handoff — multi-replica workspace

**For:** session picking up follow-up #2 from `docs/plans/2026-04-25-week-7-9-followups.md`. Don't pick this one up first if multi-replica isn't actually needed yet — it's deliberately YAGNI until real load on a real cluster forces the issue.

**Previous slices:** Weeks 1–9 (PR #9 merged). The k8s slice ships `@ax/workspace-git` as a single-replica, in-process implementation. The hook surface is correct; the storage shape is the wrong shape for HA.

**Assumes the following are in place:**
- `@ax/workspace-git` is the canonical single-replica implementation. `packages/workspace-git/src/impl.ts` registers all four service hooks (`workspace:apply` / `read` / `list` / `diff`) using `isomorphic-git` against a bare repo at `<repoRoot>/repo.git`. `MAIN_REF = 'refs/heads/main'` is the only ref. Every apply is a CAS on `MAIN_REF`, atomically combined with the new commit by `git.commit({ ref, parent })` at `impl.ts:408-419`, all inside a per-process `Mutex` at `impl.ts:48-63`.
- The mutex is the part that doesn't scale. It serializes `compare parent + write blobs/trees + commit + update ref` as a critical section — and it's per-process. Two host replicas would race in the worst possible way: both pass the parent check, both write to the same PVC, only one wins, the loser's blobs/trees become dangling objects.
- `runWorkspaceContract` in `packages/test-harness/src/workspace-contract.ts:29` is the shared 9-assertion suite. `@ax/workspace-git`'s tests at `packages/workspace-git/src/__tests__/contract.test.ts:7` exercise it. The mock workspace at `packages/test-harness/src/__tests__/mock-workspace.test.ts` proves the suite is genuinely backend-agnostic.
- `WorkspaceVersion` is opaque per the contract test "opaque versions: subscribers must NOT depend on version string format" (`workspace-contract.ts:166-178`). The fact that it's a 40-hex SHA today is an implementation detail the contract explicitly hides.
- The Helm chart at `deploy/charts/ax-next/values.yaml` declares `replicas: 1` (line 25) and a `ReadWriteOnce` PVC for workspace storage (line 68) — both block multi-replica today. The host's `@ax/workspace-git` writes to a PVC mounted inside the host pod (lines 61–69 comment block).
- NetworkPolicies live under `deploy/charts/ax-next/templates/networkpolicies/`.
- The agent-image Dockerfile (follow-up #4) is its own follow-up — coordinate. If the host already has a multi-binary image story by the time this slice lands, the git-server entrypoint becomes another binary in the same image; otherwise we ship a separate Dockerfile.
- `@ax/workspace-git`'s SECURITY.md captures the "single-replica only" known limit explicitly (`packages/workspace-git/SECURITY.md` line 109). This handoff retires that limit.

If `@ax/workspace-git` diverged — particularly if someone landed an external-lock variant or split `impl.ts` — revisit decisions below.

---

## Goal

Make `@ax/workspace-git`'s contract work across multiple host replicas without serializing through a single process. The four hooks stay identical (Invariant 1: hook surface is storage-agnostic); the implementation moves the parent-CAS authority out of an in-process `Mutex` and into a single git-server pod that owns the bare repo.

After this lands, `replicas: 1` becomes configurable in the chart and `HorizontalPodAutoscaler` + `PodDisruptionBudget` can land alongside (follow-up #9 from the followups doc).

## Architecture decision baked in

After reading `impl.ts` and the SECURITY.md "Known limits" section, the cleanest factoring is **a three-package split with a shared core**, mirroring what we did for IPC in #1:

- **`@ax/workspace-git-core`** — extract the existing `impl.ts` (hook registration + isomorphic-git plumbing + path validation + delta builder). No plugin manifest of its own; just exported functions + types. The mutex stays here — it's correct *for a single-process owner of the repo*, which is exactly what both consumers need.
- **`@ax/workspace-git`** — shrinks to a thin plugin wrapper that depends on `@ax/workspace-git-core`. Registers the four hooks against a local bare repo, exactly as today. Single-replica use case.
- **`@ax/workspace-git-http`** — new package, two exports:
  - `createWorkspaceGitHttpPlugin({ baseUrl, token })` — host-side plugin. Registers the four hooks. Each hook forwards over HTTP to the git-server pod. No git knowledge here — the host doesn't import `isomorphic-git`.
  - `createWorkspaceGitServer({ repoRoot, port, token })` — pod-side process. Imports `@ax/workspace-git-core`, wraps the in-process impl in a thin HTTP server (mirror the protocol shape from `@ax/ipc-http` for consistency).

**Why this shape:**
- The in-process mutex moves with the impl into the git-server pod, where it's still the right tool — exactly one process owns the repo. No new lock primitive needed.
- The `runWorkspaceContract` suite runs against `@ax/workspace-git-http` end-to-end (boot a git-server in a child process, point the host plugin at it). All 9 assertions must pass — that's the I1 proof the followups doc demands.
- The host plugin imports nothing git-specific. It's a thin RPC client. If `WorkspaceVersion` ever changes shape (e.g., we ship a non-git backend), the host plugin is unaffected.
- Symmetric with #1's `@ax/ipc-core` extraction — the codebase will have a consistent "extract a core, build transports on top" pattern for these cross-pod cases.

**What we considered and rejected:**
- **(a)** Mount the same PVC into multiple host replicas (ReadWriteMany). Most cloud storage classes don't support RWM; isomorphic-git has no fcntl-based locking; the mutex would do nothing across processes. Hard reject.
- **(b)** Use stock git smart-HTTP via `git-http-backend` CGI behind nginx/apache + isomorphic-git's `http/node` variant on the host. Mature, standard. Rejected because: (1) it pulls in network capability via `simple-get` from `isomorphic-git`, which `@ax/workspace-git`'s SECURITY.md (line 87) deliberately excludes; (2) the workspace-protocol surface is bigger than smart-HTTP needs (read/list/diff aren't naturally git-fetch ops); (3) bearer-auth + timingSafeEqual is uniform with #1's HTTP-IPC story if we own the protocol.
- **(c)** Postgres advisory lock from each host replica directly against the PVC (still RWM). Rejected for the same RWM reason.

## Deliverables

- **`@ax/workspace-git-core`** package extraction. Move `impl.ts` and the path-validation helpers out of `@ax/workspace-git` into the new core. Export `registerWorkspaceGitHooks(bus, config)` (already the public surface today) plus the lower-level pieces an HTTP server needs: a function that takes `WorkspaceApplyInput` and returns `WorkspaceApplyOutput` against a `gitdir`, same for read/list/diff. The mutex stays inside the core, scoped per-`gitdir`.
- **`@ax/workspace-git`** rewrite as a thin wrapper. Existing tests at `packages/workspace-git/src/__tests__/contract.test.ts` pass unchanged — the hook surface is identical. SECURITY.md updates to reflect the package being a wrapper; the security walk that already covers the impl now lives in `@ax/workspace-git-core/SECURITY.md`.
- **`@ax/workspace-git-http`** new package.
  - **Host-side plugin.** Same four hooks, each forwards over HTTP. Each request body carries the hook input as JSON, response body carries the hook output. Same `Authorization: Bearer ${token}` + `crypto.timingSafeEqual` server-side as #1's HTTP IPC. Reuse `@ax/ipc-core` (post-#1) if its primitives fit — auth, body framing, response writers should all be transport-agnostic enough by then.
  - **Pod-side HTTP server.** Wraps `@ax/workspace-git-core`. Single replica by design (the chart's git-server Deployment is `replicas: 1` always — adding more would re-introduce the multi-writer race we're solving here). Mutex inside `core` serializes concurrent applies coming from multiple host replicas; losers throw `parent-mismatch` and the host plugin propagates the `PluginError` cleanly so callers can retry.
  - **`runWorkspaceContract` test integration.** Boot the server in-process for tests; the 9-assertion suite runs as the I1 proof. Plus a multi-replica concurrency test: spin up one git-server, attach 3 host plugins, fire concurrent applies — assert N-1 get `parent-mismatch` and a retry loop produces a linear history with all changes.
- **Helm chart additions.**
  - `templates/git-server/deployment.yaml` — `replicas: 1` (always — see comment above), single-pod owns the bare repo.
  - `templates/git-server/service.yaml` — ClusterIP, exposes the HTTP port.
  - `templates/git-server/pvc.yaml` — `ReadWriteOnce` is fine here (single writer pod).
  - `templates/networkpolicies/git-server-network.yaml` — host pods CAN reach git-server on the protocol port; runner pods CANNOT (they go through the host plugin via the existing IPC channel).
  - `values.yaml`: new `gitServer:` block with `image`, `port`, `storage`, `storageClassName`, `accessMode`. The existing `workspace:` PVC block becomes irrelevant when the http variant is selected — gate it behind `workspace.backend: local | http` config.
  - Make `replicas: 1` configurable in `values.yaml:25`. **Don't ship HPA/PDB in this PR** — that's follow-up #9, and it should land alongside a soak test that proves the multi-replica path actually works under load.
- **Auth.** Same gate as #1: bearer token in `Authorization`, `crypto.timingSafeEqual` server-side. The token is shared between host pod and git-server pod via a Helm-managed Secret — *not* `AX_AUTH_TOKEN` (that's the per-session runner token). New env var, new Secret. Document the rotation story in the new SECURITY.md.
- **TLS.** Same answer as #1: plain HTTP within the cluster + NetworkPolicy as the perimeter for v1. mTLS is a future upgrade.
- **`@ax/preset-k8s` updates.** Swap `@ax/workspace-git` for `@ax/workspace-git-http` in the preset. The local preset (`@ax/preset-local`) keeps `@ax/workspace-git` (single-replica is the right shape on a developer laptop).

## Scope decisions to make while writing the plan

1. **Where exactly does the protocol live?** Three sub-options:
   - Reuse `@ax/ipc-core` (from #1) for auth + body framing + response writers, and define workspace-specific request schemas in `@ax/ipc-protocol` next to the existing IPC actions. Cleanest.
   - Define a new `@ax/workspace-protocol` package. Higher purity (workspace and IPC are different concerns), more package overhead.
   - Inline schemas in `@ax/workspace-git-http`. Lowest ceremony, harder to reuse if a fourth transport ever shows up.
   - **Recommendation:** the first option, *if* `@ax/ipc-core` lands first. Otherwise inline and refactor later.

2. **Sharing `@ax/ipc-core` server-side primitives.** The git-server pod's HTTP server is structurally identical to the runner pod's: bearer auth, JSON body, JSON response, MAX_FRAME cap, fail-fast on Content-Length, `timingSafeEqual` token check. If `@ax/ipc-core` is well-factored after #1, the git-server is ~50 lines of "register routes, listen on port." If not, we duplicate. Plan for the favorable case; degrade gracefully if it doesn't pan out.

3. **Single-image vs. separate-image for the git-server.** Two paths:
   - Same image as the host (and the runner). Just a different entrypoint. Simpler operations; one CVE story; one image to scan. Matches the bundled-runner pattern the chart already uses.
   - Separate slim image for the git-server. Smaller attack surface; more to maintain.
   - **Recommendation:** same image. The git-server's process surface is small enough that it doesn't justify a separate image. Coordinate with follow-up #4 (`Dockerfile.agent`).

4. **Workspace-version retry policy.** Today `@ax/workspace-git` throws `parent-mismatch` and the caller (the chat orchestrator) decides what to do. Across replicas, that throw is more frequent — concurrent turns from different sessions could collide. Two paths:
   - Keep current behavior — `PluginError` bubbles up; the runner retries by re-resolving HEAD and re-applying. Ratio of conflicts → retries is the load metric.
   - Add a tiny retry-with-backoff loop inside `@ax/workspace-git-http`'s host plugin (3 attempts, jittered). Hides transient conflicts from the orchestrator.
   - **Recommendation:** keep current behavior for v1. Adding a retry loop without a real workload is guessing. Add it when an oncall ticket says "we got 50 parent-mismatches in an hour."

5. **Backup / disaster recovery.** The git-server PVC is now the single source of workspace truth. If the PVC dies, we lose every workspace. Options to think about (don't necessarily ship in this slice):
   - Periodic `git bundle` push to S3.
   - Volume snapshot policy at the storage class level.
   - Replicated storage class (e.g., Longhorn, Rook).
   - **Recommendation:** document the gap in `@ax/workspace-git-http/SECURITY.md` under "Known limits" — explicit "no DR yet, your storage class's redundancy is what you have." Defer the actual DR mechanism to a follow-up; don't bundle it with this slice.

6. **Empty-turn behavior.** `@ax/workspace-git`'s `apply` short-circuits when `changes.length === 0 && currentVersion !== null` (`impl.ts:388-397`) — returns `{version: currentVersion, delta: {before, after, changes:[]}}` without touching git. This optimization MUST be preserved over the wire — the host plugin shouldn't even round-trip if it can detect "empty changes" client-side. Keeps quiet turns from hammering the git-server pod.

## Security — `security-checklist` required

The git-server pod is a new network endpoint. Three threat models:

- **Sandbox escape.** RBAC + NetworkPolicy must constrain the git-server pod tightly: it owns one PVC, listens on one port, has zero outbound network reach. No shell tools in the image (no `git` binary either if we go pure-isomorphic-git, which we should). The blast radius if the pod is compromised: an attacker can read every workspace's content. That's a meaningful escalation from `@ax/workspace-git`'s blast radius (one host pod) — the SECURITY.md must call this out, and the new NetworkPolicy must enforce that *only host pods* can reach the git-server port. Runner pods MUST NOT.
- **Prompt injection.** Tool output reaching the host eventually reaches `workspace:apply`. The validation chokepoint at `impl.ts:84-136` (`validatePath`) moves into `@ax/workspace-git-core` and runs on the *host plugin* side, not the server side — the wire format never carries un-validated paths. Re-validate server-side as defense-in-depth (the path could in theory be tampered with on the wire, even with bearer auth, if there's ever a CVE in the auth code). Schema-validate every request body the same way `@ax/ipc-core` does.
- **Supply chain.** The git-server pod's runtime is `@ax/workspace-git-core` + Node + `isomorphic-git` + `picomatch`. Same surface as today's `@ax/workspace-git` (existing SECURITY.md covers this in detail at lines 74-99). One new dependency in `@ax/workspace-git-http`: Node's built-in `http`. Resist adding any HTTP framework — same rule as #1.

New SECURITY.md required for **both** new packages:
- `@ax/workspace-git-core/SECURITY.md` — inherit the bulk of the existing `@ax/workspace-git/SECURITY.md` since the substantive code didn't change (it just moved). Update the boundary review to reflect the new package boundary.
- `@ax/workspace-git-http/SECURITY.md` — focus on the new wire surface. Walk all three threat models. Document the auth-token rotation story explicitly.

Update `deploy/charts/ax-next/SECURITY.md` for the new git-server pod (RBAC, NetworkPolicy, PVC, the no-DR known limit).

Update `@ax/workspace-git/SECURITY.md`: drop the "Single-replica only" known limit (line 109) — the http variant addresses it.

## Legacy helpers to port (read-only `~/dev/ai/ax/`)

- Legacy v1 had a git-server container in k8s for multi-replica. Read its Helm chart (or whatever the deploy story was) for the pod spec, RBAC, NetworkPolicy shapes — particularly how it scoped the PVC and how it handled SIGTERM (we want a clean shutdown that finishes any in-flight commit before exit; see follow-up #3 for the kernel shutdown story this composes with).
- Legacy's protocol between host and git-server: read it for inspiration but **don't blindly port**. Their wire shape was driven by their broader v1 architecture; we want our protocol to be tight and to mirror our hook surface 1:1.
- Do NOT port any v1 hand-rolled atomic-update logic if it was built on shell-out to `/usr/bin/git` — we're staying pure-isomorphic-git for the same reasons captured in `@ax/workspace-git/SECURITY.md` line 32 ("Process spawn: None").

## Acceptance criteria

**Automated:**
- `runWorkspaceContract('@ax/workspace-git-http', ...)` — all 9 assertions pass against the http variant. Boot the git-server in-process; point the host plugin at `http://127.0.0.1:<port>`. This is the **I1 proof** — same suite, two backends, identical behavior.
- Multi-replica concurrency test in `@ax/workspace-git-http`: one in-process git-server, three host plugins, each fires `apply` concurrently against the same parent. Assert that exactly one succeeds, the other two get `parent-mismatch`, a retry loop produces a linear history with all three changes, the final `list` shows all expected paths.
- `runWorkspaceContract('@ax/workspace-git', ...)` still passes (the wrapper rewrite must not regress — the existing 9 assertions are the same proof).
- `pnpm test` stays green across the monorepo.

**Manual:**
- `deploy/MANUAL-ACCEPTANCE.md` gets a new section: "multi-replica chat" — deploy with `replicas: 2`, send concurrent chat requests, verify both succeed and both result in workspace versions visible to a follow-up `git log` against the git-server PVC.
- Note: this acceptance test depends on follow-up #1 (HTTP runner-IPC) being in place — without it, multi-replica chat doesn't actually work end-to-end. **Coordinate ordering: do #1 first.**

**Estimated size:** large slice. ~1000–1500 LOC of impl + tests + chart additions + security docs. 2–3 focused days. The contract test suite carries enormous weight here — most of the I1 proof is reuse, not new tests. The fiddly parts are the Helm chart additions and getting the NetworkPolicy right. The wire protocol itself is straightforward if `@ax/ipc-core` lands first.

## Dependencies on other follow-ups

- **#1 (HTTP runner-IPC)**: required before this can be acceptance-tested end-to-end. Multi-replica host means runner pods, means HTTP IPC. Don't start this slice until #1 is merged.
- **#3 (Kernel shutdown lifecycle)**: nice-to-have. The git-server pod especially wants a clean shutdown (any in-flight commit must finish before exit, otherwise we leave dangling objects). Without #3, we ship a SIGTERM handler in the git-server entrypoint that does the right thing locally; with #3, it integrates with the kernel's shutdown order.
- **#4 (`Dockerfile.agent`)**: the git-server pod uses the same image. Coordinate the entrypoint stories (multi-binary image, entrypoint chosen via `command:` in pod spec). If #4 lands first, follow its conventions; if this slice lands first, document the entrypoint contract so #4 can integrate.
- **#9 (HPA + PDB + multi-replica host)**: this slice unblocks #9 but does NOT include it. Ship `replicas: configurable`; defer the autoscaler.

## Kickoff prompt for next session

After `/clear`:

```
Write an implementation plan for @ax/workspace-git-http (follow-up #2 from
docs/plans/2026-04-25-week-7-9-followups.md). Read
docs/plans/2026-04-25-workspace-git-http-handoff.md first — it has the
package factoring decision (@ax/workspace-git-core extraction + http
variant on top), the wire-protocol decision (custom HTTP, mirrors #1's
@ax/ipc-core), the Helm-chart additions, and the multi-replica
concurrency test that's the I1 proof. Don't start until follow-up #1
(HTTP runner-IPC) is merged — multi-replica chat depends on it. Branch
off main. Invoke security-checklist for both new packages
(@ax/workspace-git-core, @ax/workspace-git-http) and for the chart's
new git-server pod. The plan should be executable via subagent-driven-
development.
```
