import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    passWithNoTests: true,
    // Helm template invocations are slow on cold caches; bump from default.
    testTimeout: 30_000,
  },
});
