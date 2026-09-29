import { defineConfig } from 'vitest/config';

// Budgets for @ax/credential-proxy (TASK-158).
//
// One test here launches a real `git` as a credential-NEGOTIATING proxy client
// (`per-session-isolation.test.ts`: git sends its first request bare and only
// retries with the token after a 407 + Proxy-Authenticate challenge). A test
// that spawns a subprocess must not run on vitest's 5s / 10s defaults
// (`scripts/__tests__/out-of-process-test-timeouts.test.js`), so this package
// takes the same 30s / 60s this repo already chose for its other
// subprocess-heavy suites (`packages/test-harness`, `packages/workspace-git*`).
// 30s is generous on purpose: the git test costs ~150ms idle and carries its own
// 20s SIGKILL timer, so a genuine hang still fails loudly rather than being
// masked. Every hook in this package is bare, so `hookTimeout` governs all of
// them (twice the test budget, so a teardown never gets less room than the test
// it cleans up after).
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
