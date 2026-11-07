import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Some of this package's tests do work in another process or thread: a child with a 256 MB heap, a child that
    // makes a pool and never closes it, real worker threads that are ended on a deadline or run out of memory. And
    // the limit tests parse pages of 4 MiB. Under monorepo-wide contention vitest's 5s / 10s defaults are not enough
    // for a test that waits on any of that, and a timeout is the failure shape the merge queue has seen
    // (TASK-323, TASK-400). A test that wants more still says so itself.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
