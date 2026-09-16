import { defineConfig } from 'vitest/config';

// Budgets for `pnpm test:scripts` (`vitest run --root scripts`).
//
// This root had no config at all until TASK-331, so it ran on vitest's
// `testTimeout: 5_000` / `hookTimeout: 10_000` defaults. That is too tight for
// what these guards actually do — they spawn real `bash`, `zsh`, `git` and
// stub-`gh` subprocesses, and one of them resolves the repo's real
// `eslint.config.mjs` through ESLint's own loader. Under monorepo-wide
// contention a correct-but-slow test then blew the per-test budget, and vitest
// reported it as `Tests  1 failed | 152 passed (153)` — the collected total
// intact, which is indistinguishable in the summary from an assertion failure.
// A whole card went looking for a product race that was never there.
//
// The numbers, and why these ones:
//
// - `testTimeout: 30_000` — the slowest test here that is NOT the ESLint
//   warm-up is 408ms on an idle machine (`no-raw-nul-bytes`, which reads every
//   tracked non-binary file), so this is ~73x headroom on measured worst-case
//   work. It matches the precedent set for the repo's other subprocess-heavy
//   suites (`packages/workspace-git*`, TASK-73).
// - `hookTimeout: 120_000` — `eslint-ignores-worktrees.test.js` warms the flat
//   config in a `beforeAll` that declares 120_000 explicitly. A hook's own
//   argument overrides this value, so what this governs is the BARE hooks
//   beside it; pinning it to the largest budget the suite declares stops a
//   teardown from getting less room than its own suite's setup asked for.
//   `scripts/__tests__/scripts-suite-timeouts.test.js` holds that invariant.
//
// Neither number is a position on how long the work SHOULD take. A budget too
// small for legitimate work is a bug; one raised past a genuine hang is a mask.
// If a guard here starts needing more than this, find out why before raising it.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
