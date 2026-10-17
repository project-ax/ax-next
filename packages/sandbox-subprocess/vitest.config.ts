import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Each test spawns a real Node subprocess, and the shared-folders canary
    // (shared-folders-canary.acceptance.test.ts) also boots a real Postgres
    // testcontainer in a beforeAll. Under parallel `pnpm -r test` the system
    // can be heavily contended, pushing spawn() + Node startup — and container
    // boot — well past vitest's defaults. The budgets follow the repo's
    // out-of-process rule (scripts/__tests__/out-of-process-test-timeouts.test.js):
    // bare hooks (the container teardown) inherit at least what the file's own
    // startup hook declares. A genuinely hung child is still bounded by the
    // SIGKILL timeout in spawn.ts (capped at 300 s separately).
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
