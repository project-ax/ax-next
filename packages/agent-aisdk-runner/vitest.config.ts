import { defineConfig } from 'vitest/config';

// `src/__tests__/builtins.test.ts` reaches `node:child_process`, so this suite
// leaves the process and the 5s/10s defaults are not a budget anyone chose for
// it (TASK-400). 30s is the figure this repo uses for its other
// subprocess-touching suites — `packages/workspace-git*` (TASK-73, PR #146),
// `agent-runner-core`, the `scripts` root (TASK-331) — and `hookTimeout` is
// double it, so a bare teardown never gets less room than the case it is
// cleaning up after.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'test/bench/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
