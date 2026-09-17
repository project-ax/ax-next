import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Most of this package's suites are pure and take milliseconds, but
    // `egress-allowlist.canary.test.ts` (TASK-330) spins up a real Postgres
    // testcontainer in a `beforeAll`. Bare hooks otherwise inherit vitest's 10s
    // default `hookTimeout`, which container boot routinely blows past under
    // CI/monorepo-wide load — and the timeout that bites is usually the bare
    // `afterEach`/`afterAll`, not the `beforeAll` that carries its own argument.
    // Set to this package's own largest declared hook-timeout argument so a bare
    // hook is never budgeted below its own file's `beforeAll`. Same reasoning
    // (and the same numbers) as `@ax/host-grants`. See TASK-323.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
