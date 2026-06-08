# TASK-170 — Harden runner pod teardown

Retry `killPod` on transient 5xx + periodic orphan-sweep of terminated runner pods.

## Problem

A warm runner pod that exits clean (idle-reap → exit 0 → phase `Succeeded`) can be left
ORPHANED in the runner namespace forever if the host's delete call hits a transient
apiserver error. Observed on GKE Standard: pod stuck `Succeeded/Completed` 89+ min after
`pod_kill_failed` with `HTTP 500 rpc error: code = Unavailable ... throttled ...
(memory-protection)`.

Three factors:
1. `kill.ts:killPod` makes a SINGLE `deleteNamespacedPod`; any non-404 error → warn + rethrow. No retry.
2. Both call sites in `open-session.ts` wrap killPod in `.catch(() => undefined)` → the rethrow is swallowed.
3. Runner pods are bare Pods with NO ownerReference → no controller / GC reclaims them.

## Approach (no hook-surface change; RBAC already grants pods list/delete)

### Task 1 — Bounded retry in `killPod` (transient 5xx / Unavailable)

- Add `isTransientApiError(err)`: true for 5xx (`code`/`statusCode`/`response.statusCode`
  in 500–599) OR a string/`body`/`message` matching
  `/unavailable|throttl|overloaded|timeout|ServiceUnavailable/i`. False for 404 and other 4xx.
- `killPod` retries on `isTransientApiError` up to `maxAttempts` (default 3) with backoff
  `[250, 500, 1000]ms`, via a `sleep` seam (default `setTimeout`-promise) so tests run fast.
  Keep `isPodGoneError` 404 → happy path (no retry, `pod_already_gone`). A non-transient,
  non-404 error rethrows immediately (no retry). On the final failed attempt log
  `pod_kill_failed` (warn) and rethrow — preserve current behavior so the caller's
  `.catch` still swallows, but now only after exhausting retries.
- Log `pod_kill_retry` (debug/info) between attempts with attempt number.

**Test (kill.test.ts):** killPod succeeds on attempt 2 after a simulated 500 (assert 2
delete calls, resolves); a permanent 403 rethrows after 1 attempt (no retry); 404 still
resolves with a single call; `isTransientApiError` truth table.

### Task 2 — Orphan-sweep (sweep.ts)

- New `sweepOrphanedPods({ api, namespace, terminalAgeMs, now?, podLog })`: lists pods with
  `labelSelector: app.kubernetes.io/component=ax-next-runner`, keeps those whose
  `status.phase ∈ {Succeeded, Failed}` AND `metadata.creationTimestamp` older than
  `terminalAgeMs`, and `killPod`s each (gracePeriodSeconds 0 — already terminal). Returns
  a count. Best-effort: per-pod delete failure is logged + skipped, never throws; a list
  failure is logged + returns 0.
- New `startOrphanSweeper({ api, namespace, intervalMs, terminalAgeMs, podLog })` →
  `{ stop(): Promise<void> }`: the attachments-janitor pattern — run once at start, then
  `setInterval`; `unref()` the timer; `stop()` clears + awaits in-flight; idempotent.
- Extend `PodListRequest` with optional `labelSelector`. Extend mock-k8s
  `listNamespacedPod` to honor `setListResponses(...pods)` / `setListError(err)` and record
  `lists`.

**Test (sweep.test.ts):** deletes a stale terminal (Succeeded, old) pod but LEAVES a
Running one and a young terminal one; passes the runner labelSelector; list error → 0, no
throw; per-pod delete error is swallowed and the sweep continues to other pods.

### Task 3 — Wire the sweeper into the plugin lifecycle + config

- `config.ts`: add `orphanSweepIntervalMs` (default 300_000 = 5 min) and
  `orphanSweepTerminalAgeMs` (default 600_000 = 10 min) to config + resolved config.
- `plugin.ts`: in `init`, build an init `AgentContext` via `makeAgentContext`, start the
  sweeper, hold the handle; add `shutdown()` that stops it (idempotent). Mirrors
  attachments. A non-positive interval disables the sweeper (don't start a timer).

**Test (plugin sweeper wiring):** init starts a sweeper that fires a list against the
mock; shutdown stops it (no further lists after stop). Reuse existing plugin test harness
if present, else a focused test.

## YAGNI pass

- ownerReference / Job+ttlSecondsAfterFinished — DEAD at MVP → **deferred follow-up card**.
  The retry+sweep self-heals the observed failure; the controller/Job rework is larger.
- Configurable transient-matcher regex / per-attempt jitter — not needed; fixed list is fine.

## Invariants

- I1 (transport/storage-agnostic hooks): no hook surface changes. `labelSelector` is a
  k8s-internal arg on the narrow facade, not a hook payload field.
- I5 (capabilities minimized): sweep uses `list` + `delete` already granted by the host
  Role; scoped by labelSelector to runner pods only. No new grant.
- Bug Fix Policy: each task is test-first; the killPod-retry + sweep tests are the
  regressions that would have caught this.
- Not a sandbox-boundary / IPC / untrusted-content change (it's host-side k8s teardown
  hardening) → security-checklist not required, but note: the sweep only ever DELETES pods
  it created (labelSelector-scoped), never reads untrusted content.
