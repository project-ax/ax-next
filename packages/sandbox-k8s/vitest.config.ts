import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Tests mock the k8s API — no real cluster, no real pods. The default
    // 5 s timeout is plenty; we don't need to inflate it here the way
    // sandbox-subprocess does for real-spawn slowness.
    testTimeout: 5_000,
  },
});
