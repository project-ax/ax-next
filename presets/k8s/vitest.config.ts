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
    hookTimeout: 120_000,
  },
});
