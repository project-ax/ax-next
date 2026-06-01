# TASK-123 — De-flake the push-to-main full suite

**Branch:** `auto-ship/TASK-123-deflake-main-suite` · **Base:** `main`

## Problem

Two pre-existing intermittent failures on the push-to-main full run (`pnpm -r test`).
Neither reproduces on re-run; both masquerade as regressions and gate clean merges.

1. **memory-strata** `src/__tests__/plugin.test.ts:114` — `"runs the Observer on
   chat:end and writes to inbox"`. Surfaces `ENOENT: scandir '/tmp/memory-strata-plugin-XXXX/permanent/memory/inbox'`.
   **Root cause:** the Observer is intentionally fire-and-forget from `chat:end` (I6 —
   chat:end must not block on a ~30 s LLM call). The test bets a fixed 50 ms
   `waitForObserverSettle()` sleep is long enough for the `agents:resolve → llm:call →
   fs-write-inbox` chain to finish. Under parallel CI load the event loop starves and the
   inbox dir isn't created when `readdir` runs → ENOENT. Production behavior is correct;
   the TEST races a sleep.

2. **agent-claude-sdk-runner** `src/__tests__/flush-workspace-host.e2e.test.ts:300` —
   `"host-side delete after the flush sticks and the next runner commit resyncs cleanly"`.
   **Root cause:** the TASK-5/#146 load-induced class. The test sequentially spawns ~25–30
   real `git` subprocesses (setup + flush + host-retire + resync + verify). Default vitest
   `testTimeout` is 5000 ms. Under full `pnpm -r test` fan-out, git startup latency balloons
   ~10× and the test breaches 5 s. Reproduced locally: isolated body ≈ 514 ms; under 6× CPU
   overcommit the file's bodies reach ≈ 3.94 s. Every other real-git package
   (`workspace-git`, `workspace-git-core`, `workspace-git-server`, `ipc-core`) already sets
   `testTimeout: 30_000`; the runner is the lone real-git package with no override. The
   card-named signatures (ECONNRESET, "baseline-bundle fetch failed (500)", "head moved
   again — retrying commit-notify") are the resync code PATH the test exercises, not the
   failure mode (this test uses an in-process IPC mock — no socket → no real ECONNRESET).

## Tasks (independent, testable)

### Task 1 — memory-strata: deterministic Observer settle (replaces the 50 ms sleep)

- Add a test-only seam to `MemoryStrataConfig.testHooks`:
  `onObserverSettleReady?(settle: (agentId: string) => Promise<void>): void`, mirroring the
  existing `onConsolidationSettleReady`. The plugin tracks the latest per-agent
  `kickOffObserver` promise (a `lastObserverWork` map, never read by production) and `settle`
  awaits it (looping while a newer one is scheduled, same shape as `settleConsolidation`).
  `settle` resolves immediately if no Observer ever ran (so the "skips Observer on
  terminated outcomes" test still asserts the absence).
- In `plugin.test.ts`, the `"writes to inbox"` test captures `settle` via the seam and
  `await settle(ctx.agentId)` **instead of** `waitForObserverSettle()`. Delete the 50 ms
  sleep helper if no other test needs it (the "terminated" test can also use the seam, or
  keep a guarded await that resolves immediately).
- **TDD:** the new assertion must be the deterministic await; verify the test no longer
  depends on wall-clock by running it ≥20× green (and ideally under CPU load).
- Production change is test-seam-only (the seam is gated behind `testHooks`, never invoked
  in production wiring) — no hook-surface change, no boundary review.

### Task 2 — runner e2e: adequate timeout budget for the real-git tests

- Add a per-`it()` `testTimeout` of `30_000` ms to the 3 tests in
  `flush-workspace-host.e2e.test.ts` (vitest's 3rd positional arg to `it`). Per-test, NOT a
  package-wide vitest.config change, to preserve the 5 s early-hang signal for the package's
  ~28 unit test files (mirrors `sandbox-k8s` keeping 5_000 deliberately).
- Add a short comment citing the TASK-5/#146 load class + this card so a future reader
  doesn't "tidy" it away.

## Stability gate (acceptance)

- Run each affected test ≥20× in a loop, 0 flakes (ideally also under simulated CPU load).
- `pnpm build` + `pnpm test --filter @ax/memory-strata` + `pnpm test --filter
  @ax/agent-claude-sdk-runner` + lint all green.

## YAGNI / scope

- Fix ONLY the two card-named tests. `git-workspace.test.ts` shares the real-git load
  profile and is at latent risk but is currently green and out of card scope → return as a
  follow-up, do not widen.
- No `.skip` / quarantine — both have real deterministic fixes.
