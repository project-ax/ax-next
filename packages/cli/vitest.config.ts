import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 20000,
    // Some suites here spin up a real Postgres testcontainer. Bare hooks
    // otherwise inherit vitest's 10s default hookTimeout, which container
    // boot can blow past under CI/monorepo-wide load. testTimeout stays as
    // is — it's already well above default and nothing has failed against
    // it. See TASK-323.
    //
    // 120s rather than 60s because `e2e.test.ts` declares `}, 120000)` on its
    // own beforeAll, and the rule is that no bare hook is budgeted below what a
    // hook in its own package already asks for. Worth being honest about what
    // that means here: cli's 120s comes from a `pnpm --filter '@ax/cli...'
    // build`, not from a container, so this is the package where the
    // package-max rule is at its coarsest — an unrelated build step setting the
    // ceiling for fast rmSync teardowns. It is still the right side to err on
    // (a teardown budgeted under its own sibling beforeAll is the flake this
    // card exists to kill), and the extra headroom is only ever spent by a hook
    // that is already wedged.
    hookTimeout: 120_000,
  },
});
