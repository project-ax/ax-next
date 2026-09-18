import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Most of this package's tests mock the k8s API — no real cluster, no real
    // pods — and the comment here used to stop at that and keep the 5s default
    // on those grounds. It was wrong about one file.
    // `src/__tests__/read-command-shell.test.ts` runs the generated read command
    // through `execFileSync('/bin/sh', ...)` in ~20 cases, which is real
    // out-of-process work on the same 5s budget that turned
    // `packages/test-harness` into a merge-queue stoppage (TASK-400). 30s /
    // 60s, matching this repo's other subprocess-touching suites.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
