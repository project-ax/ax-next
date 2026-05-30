import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // These suites shell out to the real `git` binary many times per test
    // (bundle create/verify/fetch, clone, ls-tree, cat-file). Solo they run
    // in ~230ms, but under the full parallel `pnpm test` gate (~59 packages'
    // testcontainers + suites saturate CPU/fds) the cumulative subprocess
    // wall-time intermittently breaches vitest's 5s default and times out —
    // the load-induced flake mode that reds the main-CI backstop (TASK-73,
    // same class as the #146 timeout fix). 30s is generous headroom under
    // contention while still catching a genuine hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
