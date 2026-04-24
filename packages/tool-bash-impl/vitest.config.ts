import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Each test spawns a real /bin/bash subprocess. Under parallel
    // `pnpm -r test` the system can be heavily contended, pushing spawn()
    // + shell startup well past vitest's 5 s default. 15 s gives headroom
    // for the slowest machine without masking an actually-hung child
    // (SIGKILL timeout in exec.ts is capped at 300 s separately).
    testTimeout: 15_000,
  },
});
