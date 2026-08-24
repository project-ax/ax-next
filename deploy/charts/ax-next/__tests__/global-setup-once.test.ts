// Observes the LIVE run: the once-per-run fetch really happened in globalSetup,
// and a call made from inside a worker really does refuse to repeat it.
//
// helm-deps.test.ts proves the once-semantics against an injected spawner. This
// file proves the wiring those semantics rest on, which no fake can check.
// vitest runs globalSetup in its parent process and test files in worker
// processes, so the module-level flag in helm-deps.ts is worthless across that
// boundary — one flag per worker is the original bug shape. The interlock that
// crosses the boundary is `VITEST_WORKER_ID`, which vitest sets in workers and
// not in the parent.
//
// This file has already earned its keep once, though not for the reason it
// first appeared to. The original interlock was our own env marker stamped in
// globalSetup, and these assertions went red on CI reading `undefined` — which
// looked like proof that workers do not inherit the parent's environment. They
// were actually reporting something else: a bad commit had reverted
// `globalSetup` out of vitest.config.ts, so nothing ran and nothing was
// stamped. The assertions were right, the first diagnosis was not. What they
// really pin is "the run-level step happened and this worker can see it" — the
// thing that is false whenever the wiring breaks, whatever the reason.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHART_DIR,
  ensureChartDependencies,
  findHelm,
  inTestWorker,
  type HelmSpawner,
} from './helm-deps.js';

const HELM = findHelm();

describe('run-level chart dependency fetch', () => {
  it('this test file runs in a worker, and helm-deps can tell', () => {
    // If vitest ever stops setting this, the interlock silently stops working
    // and every worker becomes free to fetch again. That regression shows up
    // here rather than as a slow, occasionally-red chart suite.
    expect(process.env.VITEST_WORKER_ID).toBeDefined();
    expect(inTestWorker()).toBe(true);
  });

  it('a call from inside a test worker refuses to fetch', () => {
    const calls: string[] = [];
    const spawn: HelmSpawner = (_file, args) => {
      calls.push(args.join(' '));
      return { status: 0, stdout: '' };
    };
    // Deliberately the real `process.env` — that is what the interlock reads.
    expect(ensureChartDependencies({ helm: 'helm', spawn })).toEqual({
      ok: true,
      attempted: false,
      skipped: 'in-test-worker',
    });
    expect(calls).toEqual([]);
  });

  // The observable effect of globalSetup having run: the subchart tarball named
  // by Chart.lock is sitting in charts/. This is what every `helm template` in
  // the render suites depends on, and it is gitignored, so its presence can
  // only come from this run's `helm dependency build`.
  it.skipIf(HELM === null)('materialized the subchart named by Chart.lock', () => {
    const lock = readFileSync(resolve(CHART_DIR, 'Chart.lock'), 'utf8');
    const m = /-\s+name:\s*(\S+)[\s\S]*?version:\s*(\S+)/.exec(lock);
    expect(m, 'Chart.lock names a dependency').not.toBeNull();
    const [, name, version] = m!;
    expect(existsSync(resolve(CHART_DIR, 'charts', `${name}-${version}.tgz`))).toBe(
      true,
    );
  });
});
