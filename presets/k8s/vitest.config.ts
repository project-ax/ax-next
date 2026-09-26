import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // The k8s-e2e suite under __tests__/k8s-e2e/ requires a live kind
    // cluster + port-forward and lives in its own vitest config
    // (`vitest.config.k8s-e2e.ts`). Excluding it here keeps `pnpm test`
    // hermetic.
    exclude: ['src/__tests__/k8s-e2e/**', 'node_modules/**', 'dist/**'],
    // Acceptance test boots a postgres testcontainer + the full preset
    // plugin stack. Cold image pulls + bootstrap can run long on first
    // execution; subsequent runs reuse the layer cache.
    testTimeout: 60_000,
    // 180_000, not 120_000 (TASK-567). `acceptance.test.ts` and
    // `prod-bootstrap.test.ts` declare `{ timeout: 180_000 }` on their longest
    // canaries, and their teardowns — `afterAll(() => pgContainer.stop())` and
    // the tmpdir-removing `afterEach` — are BARE, so they run under this value.
    // A hook's own timeout argument would override it, but these carry none.
    // Below the tests' own budget, a slow container stop fails the run after
    // every assertion passed. `scripts/__tests__/out-of-process-test-timeouts.test.js`
    // holds this: a package with a bare teardown keeps `hookTimeout` at or above
    // its largest declared test budget.
    hookTimeout: 180_000,
  },
});
