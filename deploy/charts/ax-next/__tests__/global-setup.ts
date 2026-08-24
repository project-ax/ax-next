// Run-level setup for the chart suite: fetch the subchart dependencies once,
// in vitest's parent process, before any test worker starts.
//
// This is the hoist that TASK-316 is about. The fetch used to live in a
// `beforeAll` in each of three test files, which vitest runs in parallel —
// see helm-deps.ts for what that did to the shared helm cache. A globalSetup
// is the narrowest place that gives "exactly once per run" without serializing
// the tests themselves.
//
// Failing here aborts the whole run with helm's own stderr, which is the point:
// a real upstream outage should say "helm repo update bitnami exit 1: ...",
// not "Hook timed out in 30000ms" three files deep.

import { ensureChartDependencies, inTestWorker } from './helm-deps.js';

export function setup(): void {
  // This must be the parent process, or the interlock in helm-deps.ts would
  // refuse to fetch and every render suite would fail on a missing subchart
  // with a confusing helm error. Assert it here rather than discover it there.
  if (inTestWorker()) {
    throw new Error(
      'chart globalSetup is running inside a vitest worker (VITEST_WORKER_ID ' +
        'is set); the run-level subchart fetch would be skipped. This means ' +
        'vitest changed where globalSetup runs — see __tests__/helm-deps.ts.',
    );
  }
  const out = ensureChartDependencies();
  if (!out.ok) {
    throw new Error(
      `chart subchart fetch failed — the chart cannot render without ` +
        `postgresql in charts/: ${out.reason}`,
    );
  }
}
