import { defineConfig } from 'vitest/config';

// `src/__tests__/git-workspace.test.ts` spawns real `git` subprocesses — 44 of
// its cases already say so out loud, with `}, REAL_GIT_TIMEOUT_MS)` against a
// file-local `const REAL_GIT_TIMEOUT_MS = 30_000`. Until TASK-400 the package
// config said nothing, so every case that did NOT carry that argument, and every
// hook, ran on vitest's 5s/10s defaults. 30s matches what this package's own
// tests already ask for and the figure `packages/workspace-git*` settled on for
// real-`git` work (TASK-73, PR #146); `hookTimeout` is double, so a bare
// teardown never gets less room than the case it is cleaning up after.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
