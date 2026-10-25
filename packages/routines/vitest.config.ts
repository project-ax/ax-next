import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // This package's suites spin up a real Postgres testcontainer in a
    // beforeAll. Bare hooks otherwise inherit vitest's 10s default
    // hookTimeout, which container boot routinely blows past under
    // CI/monorepo-wide load. Set to this package's own largest declared
    // hook-timeout argument so a bare afterAll is never budgeted below its
    // own file's beforeAll. See TASK-323.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Most waits here are for a row a detached run writes after the call that
    // started it has answered (a fire's row is written by its turn-end
    // subscriber, about ten statements later). vitest's default `expect.poll`
    // budget is one second: ~10 ms on a laptop, but on a loaded CI runner,
    // where every statement can take tens of milliseconds, it ran out on main
    // with nothing wrong. A poll still answers the moment its matcher passes,
    // so the larger budget costs a green run nothing. Kept well under
    // testTimeout so a real miss fails as the matcher, not as a timeout.
    // canary.test.ts "a fire on a slow database …" holds this in place.
    expect: { poll: { timeout: 15_000 } },
  },
});
