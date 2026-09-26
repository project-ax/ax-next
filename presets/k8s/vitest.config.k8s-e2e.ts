import { defineConfig } from 'vitest/config';

// k8s-e2e — drives the local kind cluster `ax-next-dev` end-to-end. Gated
// on AX_K8S_E2E=1 at the test level so a stray invocation here doesn't
// accidentally hammer the cluster, but also kept in its own config so the
// hermetic `pnpm test` lane never imports it.
//
// Run: AX_K8S_E2E=1 pnpm vitest --config vitest.config.k8s-e2e.ts
//
// See `src/__tests__/k8s-e2e/runner-owned-sessions-k8s-gap.test.ts` for the
// regression list this suite covers.
export default defineConfig({
  test: {
    name: 'k8s-e2e',
    include: ['src/__tests__/k8s-e2e/**/*.test.ts'],
    // Each test owns SSE/runner-pod waits up to 90s; 4 mins of headroom
    // protects against a slow first model call without normalizing
    // pathological latency.
    testTimeout: 240_000,
    // 180_000, not 60_000 (TASK-575). The suite's tests declare
    // `{ timeout: 180_000 }`, and its cleanup `afterAll` (deleting every agent
    // and conversation the run created, over the port-forward) is BARE, so it
    // runs under this value. Below the tests' own budget, a slow cleanup fails
    // the run after every assertion passed. Same rule as `vitest.config.ts`
    // (TASK-567); `scripts/__tests__/out-of-process-test-timeouts.test.js` now
    // reads every vitest config a package uses, this one included.
    hookTimeout: 180_000,
    // Sequential — the cluster is shared mutable state. Two tests racing
    // on the same `ax-next-runners` namespace would tear each other's
    // pod-count assertions apart.
    fileParallelism: false,
  },
});
