import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // human-rest-integration starts a real Postgres testcontainer inside each
    // test body; that alone takes ~4-5s on an idle machine, so vitest's 5s
    // default testTimeout fails it under CI load. Same budget as @ax/routines,
    // whose harness it reuses (TASK-323).
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
