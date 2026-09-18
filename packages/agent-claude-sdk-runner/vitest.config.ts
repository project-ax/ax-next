import { defineConfig } from 'vitest/config';

// `src/__tests__/flush-workspace-host.e2e.test.ts` spawns real `git`, and four
// of its cases already declare `}, E2E_TIMEOUT_MS)` against a file-local
// `const E2E_TIMEOUT_MS = 30_000`. Until TASK-400 the package config said
// nothing, so every case without that argument — and every hook — ran on
// vitest's 5s/10s defaults. 30s matches what the file already asks for;
// `hookTimeout` is double it, so a bare teardown never gets less room than the
// case it is cleaning up after.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
