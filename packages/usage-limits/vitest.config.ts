import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Store/plugin suites start a real Postgres testcontainer in a beforeAll.
    // Bare hooks otherwise inherit vitest's 10s default hookTimeout, which
    // container boot routinely blows past under CI/monorepo-wide load (same
    // budget as @ax/attachments; see TASK-323).
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
