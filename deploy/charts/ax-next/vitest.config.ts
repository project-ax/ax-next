import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    passWithNoTests: true,
    // Helm template invocations are slow on cold caches; bump from default.
    testTimeout: 30_000,
    // beforeAll runs `helm dependency build` (parallel test files contend
    // on the bitnami subchart fetch). 30s gives the second-arriving file
    // headroom to wait + retry.
    hookTimeout: 30_000,
  },
});
