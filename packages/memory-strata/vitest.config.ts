import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts', 'test/bench/__tests__/**/*.test.ts'],
    // The bench smoke test loads TWO native modules into its worker
    // (better-sqlite3, plus the sqlite-vec extension it loads into a
    // connection). Tearing those down is slow, and on a saturated 4-vCPU CI
    // runner — where this package's 61 files compete for cores — it regularly
    // overran vitest's 10s default. That timeout does not abort anything: the
    // pool still awaits `runner.stop()` (cli-api's `exitPromises`), it just
    // LOGS `[vitest-pool]: Timeout terminating forks worker`, and that logged
    // error is what turns the run red while every one of the 581 tests passes.
    //
    // So this buys the slowest worker room to exit rather than hiding a
    // failure — there is no failing assertion behind it. It ran clean locally
    // in 450ms; only the loaded runner needed the headroom.
    teardownTimeout: 60_000,
  },
});
