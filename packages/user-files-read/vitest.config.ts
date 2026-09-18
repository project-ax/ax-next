import { defineConfig } from 'vitest/config';

// `src/__tests__/confined-read.test.ts` shells out to `mkfifo` through
// `spawnSync`, so this suite leaves the process (TASK-400). The work itself is
// trivial and nothing here is near the old 5s ceiling — this is about not
// running on a budget nobody chose, which is how `packages/test-harness` came to
// halt the merge queue. 30s / 60s keeps the figure uniform with the repo's other
// subprocess-touching suites rather than inventing a fourth number.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
