import { defineConfig } from 'vitest/config';

// Budgets for @ax/test-harness. (TASK-400)
//
// This package had no budgets at all, so it ran on vitest's `testTimeout: 5_000`
// / `hookTimeout: 10_000` defaults. On 2026-09-18 that halted the merge queue —
// `main` 7b727ae0, CI run 35354632189:
//
//     FAIL src/__tests__/stub-runner.test.ts
//          > fires event.chat-end with the assistant-text content when present
//     Error: Test timed out in 5000ms.
//     Tests  1 failed | 59 passed (60)
//
// A re-run went green, which is exactly why the number below is not the point on
// its own — `scripts/__tests__/out-of-process-test-timeouts.test.js` is what
// stops the next package arriving here unbudgeted.
//
// Why 30s, measured rather than rounded:
//
// - That test costs **64ms** on an idle machine. CI cut it off at 5373ms, i.e.
//   at ~84x — and a timeout is censored from above, so nobody knows what it
//   actually needed. Its neighbours in `mcp-server-stub.test.ts` COMPLETED in
//   the same CI run at 1282/1467/2009ms against 91-95ms idle: 14-21x.
// - Local load does not reproduce that. Under 32 busy workers on a 14-core box
//   the worst case moved 95ms -> 253ms (~2.5x), so the honest statement is that
//   local measurement bounds nothing here; CI contention is a different animal
//   and the CI numbers are the only ones that count.
// - 30s is ~5.6x the one measured CI worst case and ~470x this suite's idle
//   cost, which absorbs contention an order of magnitude worse than the run that
//   broke the queue. It is also exactly what this repo already chose for its
//   other subprocess-heavy suites — `packages/workspace-git*` (TASK-73, PR #146)
//   and the `scripts` root (TASK-331) — and this package is that same class: it
//   spawns real Node subprocesses and drives them over real MCP stdio.
// - Not 60s (the container-package figure) on purpose. A container boot
//   genuinely needs tens of seconds; a subprocess spawn does not, so the extra
//   30s would buy hang-masking rather than headroom.
//
// `hookTimeout: 60_000` — a hook's own timeout ARGUMENT overrides this value, so
// what this governs is the BARE hooks. Every hook in this package is bare (the
// `afterEach` in `stub-runner.test.ts` and `mcp-server-stub.test.ts`, both of
// which kill a real child process and await a transport close), so this value
// governs all of them. Twice the test budget, per the ratio 18 other packages
// here use: a teardown should never get less room than the test it is cleaning
// up after.
//
// Neither number is a position on how long the work SHOULD take. A budget too
// small for legitimate work is a bug; one raised past a genuine hang is a mask.
// If this suite starts needing more than this, find out why before raising it.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
