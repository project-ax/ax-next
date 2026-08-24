import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Most of this package's suites spin up a real Postgres testcontainer in a
    // beforeAll. Cold image pulls + boot — and CPU/socket contention when the
    // whole monorepo's suites run at once — routinely blow past vitest's 10s
    // default hookTimeout (the "Hook timed out in 10000ms" flake). Match the
    // sibling Postgres-testcontainer packages (database-postgres,
    // eventbus-postgres, session-postgres, storage-postgres) and give the
    // container-startup hooks generous headroom. See TASK-103 / TASK-73.
    //
    // hookTimeout governs only the *bare* hooks — a file with an explicit
    // `}, N)` on its own beforeAll/afterAll overrides this. Several files
    // here already declare 120_000, so 60_000 left their bare afterAll
    // teardowns under-budgeted relative to their own file's beforeAll.
    // Raised to match. See TASK-323.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
