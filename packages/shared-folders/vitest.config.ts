import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // This package's suites spin up a real Postgres testcontainer in a
    // beforeAll. Bare hooks otherwise inherit vitest's 10s default
    // hookTimeout, which container boot routinely blows past under
    // CI/monorepo-wide load. See TASK-323.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
