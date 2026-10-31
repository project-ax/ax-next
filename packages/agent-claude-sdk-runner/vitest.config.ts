import { defineConfig } from 'vitest/config';

// Several suites here drive real processes — the `claude` binary
// (`*-real-sdk.e2e.test.ts`) and process groups (`interrupt-processes.test.ts`)
// — and run slower under full-suite load, so the package default is 30s per
// case instead of vitest's 5s; cases that need more declare it themselves.
// `hookTimeout` is double it, so a bare teardown never gets less room than the
// case it is cleaning up after.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
