import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // The store and cleanup suites boot a real Postgres testcontainer. Bare
    // hooks otherwise inherit vitest's 10s default hookTimeout, which container
    // boot routinely blows past under CI/monorepo-wide load (TASK-323).
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
