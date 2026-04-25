import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Acceptance test boots a postgres testcontainer + the full preset
    // plugin stack. Cold image pulls + bootstrap can run long on first
    // execution; subsequent runs reuse the layer cache.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
