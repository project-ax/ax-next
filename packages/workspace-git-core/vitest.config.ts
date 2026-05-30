import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // These suites shell out to the real `git` binary many times per test
    // (init, fetch, ls-tree, cat-file, bundle). Solo they're sub-second, but
    // under the full parallel `pnpm test` gate the cumulative subprocess
    // wall-time can intermittently breach vitest's 5s default and time out —
    // the load-induced flake mode (TASK-73, same class as the #146 fix). 30s
    // is generous headroom under contention while still catching a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
