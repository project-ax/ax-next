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
  },
});
