import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // Eight of this package's ten suites boot a real Postgres testcontainer,
    // and several — admin-route, claim-route, model-route — boot a WHOLE stack
    // (database-postgres + http-server + auth-better + onboarding) per `it`,
    // not once per file.
    //
    // On a warm dev machine that is cheap (~110-200ms per test). On CI it is
    // not: cold image pulls, a shared 4-vCPU runner, and the whole monorepo's
    // suites running at once. `admin-route.test.ts` was passing there at
    // 19,099ms for 4 tests, then tipped over into
    // `Test timed out in 5000ms` on the first full-suite run busy enough to
    // push one `bootStack()` past vitest's 5s default.
    //
    // It only ever reddened `main`: PRs run "affected packages + dependents",
    // which usually skips this package, so `main` runs the full suite and eats
    // the failure alone. No failing assertion was ever behind it — the budget
    // was simply wrong for the work. Matches the sibling
    // Postgres-testcontainer packages (@ax/agents, @ax/storage-postgres,
    // @ax/memory-strata-index-postgres), which all landed on the same 60s pair
    // for the same reason.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
