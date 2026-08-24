import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    passWithNoTests: true,
    // Helm template invocations are slow on cold caches; bump from default.
    testTimeout: 30_000,
    // The subchart fetch (`helm repo add`/`update` + `helm dependency build`)
    // runs HERE — once per run, in the parent process, before any worker
    // starts. It used to run from a `beforeAll` in each of three test files,
    // in parallel, which raced on the shared helm cache; see
    // __tests__/helm-deps.ts for the full account.
    //
    // No `hookTimeout` override any more, deliberately. Nothing in this suite
    // does helm work in a hook, so there is no hook for a longer clock to
    // help — and raising it was the wrong fix: a bigger timeout only lets
    // concurrent writers retry longer, and a lossy write does not get less
    // lossy with more time.
    globalSetup: ['./__tests__/global-setup.ts'],
  },
});
