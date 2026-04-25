import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Cold testcontainer pulls + boot can run long on first execution.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
