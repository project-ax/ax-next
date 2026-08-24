import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 20000,
    // Some suites here spin up a real Postgres testcontainer. Bare hooks
    // otherwise inherit vitest's 10s default hookTimeout, which container
    // boot can blow past under CI/monorepo-wide load. testTimeout stays as
    // is — it's already well above default and nothing has failed against
    // it. See TASK-323.
    hookTimeout: 60_000,
  },
});
