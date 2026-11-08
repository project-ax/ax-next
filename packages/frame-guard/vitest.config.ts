import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Some of this package's tests do work in another process: a child with a 256 MB heap, a child that
    // makes a pool and never closes it, real worker processes that are ended on a deadline or run out of memory. And
    // the limit tests parse pages of 4 MiB. Under monorepo-wide contention vitest's 5s / 10s defaults are not enough
    // for a test that waits on any of that, and a timeout is the failure shape the merge queue has seen
    // (TASK-323, TASK-400). A test that wants more still says so itself.
    //
    // Two do: prepare-pool-shapes.test.ts builds the package in a beforeAll (120 s, for a cold build on a loaded
    // machine) and runs a child process three times in a test on a 90 s budget. The repo's rules (TASK-567, TASK-575)
    // hold `hookTimeout` to the largest budget a hook or a test here declares, because a bare teardown elsewhere in the
    // package runs under it, so it is the largest of them.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
