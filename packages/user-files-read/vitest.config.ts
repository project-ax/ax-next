import { defineConfig } from 'vitest/config';

// The test files leave the process. Each shells out to `mkfifo` through
// `spawnSync` (TASK-400), and confined-read.test.ts's race test runs a second
// node process that swaps a directory for a symlink while the reader reads.
// That race test bounds itself at 15s of reads and sets its own 30s timeout;
// everything else here is trivial and nowhere near the old 5s ceiling. The
// figures below are about not running on a budget nobody chose, which is how
// `packages/test-harness` came to halt the merge queue. 30s / 60s keeps the
// figure uniform with the repo's other subprocess-touching suites rather than
// inventing a fourth number.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
