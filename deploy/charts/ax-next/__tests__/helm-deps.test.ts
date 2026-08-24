// Unit tests for the run-level subchart fetch. Pure call-counting against an
// injected spawner — no helm, no network, no chart render — so these run
// everywhere, including the CI `test` job that ships no helm.
//
// The contract under test is the one TASK-316 exists to establish: the fetch
// happens AT MOST ONCE per vitest run. Before the fix it happened once per test
// FILE, three files in parallel, each with a 3x retry, all writing the same
// `~/.cache/helm/repository/bitnami-index.yaml` with `--force-update`. Up to
// nine lossy writes; two `Hook timed out in 30000ms` failures on main.
//
// "Once per run" has two halves and both are asserted here:
//
//   1. Once per process — the module flag. Repeated calls short-circuit.
//   2. Only from the run's PARENT process — the `VITEST_WORKER_ID` interlock.
//      vitest sets that variable in workers and not in the parent, so a stray
//      call from inside a test file declines to fetch. The companion assertion
//      that a real worker is recognised as one is in global-setup-once.test.ts,
//      which observes the live run.
//
// The source-shape half of the guard — that no test file grows its own copy of
// the fetch again — lives in
// scripts/__tests__/helm-dependency-sync-single-source.test.js.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BITNAMI_REPO,
  BITNAMI_URL,
  ensureChartDependencies,
  inTestWorker,
  resetChartDependencyStateForTests,
  type HelmSpawner,
} from './helm-deps.js';

type Call = { file: string; args: readonly string[] };

/** A spawner that records every call and reports success. */
function recordingSpawner(
  overrides: { stdout?: string; failOn?: (args: readonly string[]) => boolean } = {},
): { spawn: HelmSpawner; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: HelmSpawner = (file, args) => {
    calls.push({ file, args });
    if (overrides.failOn?.(args)) return { status: 1, stderr: 'boom' };
    return { status: 0, stdout: overrides.stdout ?? '' };
  };
  return { spawn, calls };
}

/**
 * A parent-process environment: no `VITEST_WORKER_ID`, so the interlock allows
 * the fetch. Never the real `process.env` — these tests run IN a worker, where
 * the real environment (correctly) refuses.
 */
function parentEnv(): Record<string, string | undefined> {
  return {};
}

beforeEach(() => {
  resetChartDependencyStateForTests();
});

describe('ensureChartDependencies: at most one fetch per run', () => {
  it('repeated calls in one process spawn the fetch exactly once', () => {
    const { spawn, calls } = recordingSpawner();
    const env = parentEnv();

    for (let i = 0; i < 5; i += 1) {
      expect(ensureChartDependencies({ helm: 'helm', spawn, env }).ok).toBe(true);
    }

    // repo list + repo add + dependency build. Five calls in, three spawns out.
    expect(calls.map((c) => c.args)).toEqual([
      ['repo', 'list', '-o', 'json'],
      ['repo', 'add', BITNAMI_REPO, BITNAMI_URL],
      ['dependency', 'build', expect.any(String)],
    ]);
  });

  it('reports the first call as attempted and names the skip afterwards', () => {
    const { spawn } = recordingSpawner();
    const env = parentEnv();
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: true,
    });
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: false,
      skipped: 'already-attempted',
    });
  });

  // The cross-process half. Only the run's parent may fetch; a call from inside
  // a test worker must not touch the shared helm cache at all. `VITEST_WORKER_ID`
  // is set by vitest itself, so this needs no assumption about when the worker
  // pool snapshots its environment — see the note in helm-deps.ts.
  it('refuses to fetch from inside a vitest worker', () => {
    const { spawn, calls } = recordingSpawner();
    const env = { VITEST_WORKER_ID: '3' };

    expect(inTestWorker(env)).toBe(true);
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: false,
      skipped: 'in-test-worker',
    });
    expect(calls).toEqual([]);
  });

  // Any value counts, including an empty string — worker 0's id stringifies to
  // "0", and a falsy-check would have let that one worker through.
  it('treats any VITEST_WORKER_ID value as "inside a worker"', () => {
    for (const id of ['0', '', '1']) {
      expect(inTestWorker({ VITEST_WORKER_ID: id }), `id ${JSON.stringify(id)}`).toBe(
        true,
      );
    }
    expect(inTestWorker({})).toBe(false);
  });

  // "One attempt, win or lose." Flagging only on success would let a failure
  // re-enter the fetch — which is how the old 3x retry rebuilt the very
  // contention it was retrying around.
  it('does not retry after a failure, and still counts as attempted', () => {
    const { spawn, calls } = recordingSpawner({
      failOn: (args) => args[0] === 'dependency',
    });
    const env = parentEnv();

    const first = ensureChartDependencies({ helm: 'helm', spawn, env });
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.reason).toContain('helm dependency build exit 1');

    const spawnsAfterFailure = calls.length;
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: false,
      skipped: 'already-attempted',
    });
    expect(calls.length).toBe(spawnsAfterFailure);
  });

  it('never passes --force-update', () => {
    const { spawn, calls } = recordingSpawner();
    ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(calls.flatMap((c) => c.args)).not.toContain('--force-update');
  });
});

describe('ensureChartDependencies: which single helm call it makes', () => {
  /** `helm repo list -o json` output for the given entries. */
  const repoList = (entries: Array<{ name: string; url: string }>) =>
    JSON.stringify(entries);

  it('registers the repo when bitnami is absent (fresh CI runner)', () => {
    // Measured: with no repositories.yaml at all, helm prints `[]` and exits 0.
    const { spawn, calls } = recordingSpawner({ stdout: '[]' });
    ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(calls[1]!.args).toEqual(['repo', 'add', BITNAMI_REPO, BITNAMI_URL]);
  });

  // Already registered: `add` without `--force-update` would error, and forcing
  // is what we deleted. `update` re-downloads just the index — which also
  // repairs the stale/empty cached index the old flag was covering for.
  it('refreshes the index when bitnami is already registered (dev box)', () => {
    const { spawn, calls } = recordingSpawner({
      stdout: repoList([{ name: BITNAMI_REPO, url: BITNAMI_URL }]),
    });
    ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(calls[1]!.args).toEqual(['repo', 'update', BITNAMI_REPO]);
  });

  // helm resolves Chart.yaml's `repository:` by URL, not by name, so a box that
  // registered the same URL under another name is a WORKING setup. Refreshing
  // the hard-coded name `bitnami` there fails with "no repositories found
  // matching bitnami" — refresh the name we actually found.
  it('refreshes by the name the URL is registered under, not a fixed one', () => {
    const { spawn, calls } = recordingSpawner({
      stdout: repoList([
        { name: 'other', url: 'https://charts.example.com/other' },
        { name: 'bitnami-mirror', url: `${BITNAMI_URL}/` },
      ]),
    });
    ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(calls[1]!.args).toEqual(['repo', 'update', 'bitnami-mirror']);
  });

  // The URL match is exact, never a substring — an attacker-controlled host can
  // contain ours. This is the CodeQL js/incomplete-url-substring-sanitization
  // shape, and it was in this function's first draft.
  it('does not treat a host that merely CONTAINS the bitnami URL as registered', () => {
    const { spawn, calls } = recordingSpawner({
      stdout: repoList([
        { name: 'decoy', url: 'https://evil.example/charts.bitnami.com/bitnami' },
      ]),
    });
    ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(calls[1]!.args).toEqual(['repo', 'add', BITNAMI_REPO, BITNAMI_URL]);
  });

  it('treats unreadable or non-array repo output as "not registered"', () => {
    for (const stdout of ['', 'not json', 'null', '{"name":"bitnami"}']) {
      resetChartDependencyStateForTests();
      const { spawn, calls } = recordingSpawner({ stdout });
      ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
      expect(calls[1]!.args, `stdout ${JSON.stringify(stdout)}`).toEqual([
        'repo',
        'add',
        BITNAMI_REPO,
        BITNAMI_URL,
      ]);
    }
  });

  it('surfaces a repo-refresh failure with helm stderr, not a timeout', () => {
    const { spawn } = recordingSpawner({
      stdout: '[]',
      failOn: (args) => args[0] === 'repo' && args[1] === 'add',
    });
    const out = ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe(
      `helm repo add ${BITNAMI_REPO} exit 1: boom`,
    );
  });

  it('names the update path in the failure reason too', () => {
    const { spawn } = recordingSpawner({
      stdout: repoList([{ name: 'bitnami-mirror', url: BITNAMI_URL }]),
      failOn: (args) => args[0] === 'repo' && args[1] === 'update',
    });
    const out = ensureChartDependencies({ helm: 'helm', spawn, env: parentEnv() });
    expect(out.ok === false && out.reason).toBe(
      'helm repo update bitnami-mirror exit 1: boom',
    );
  });

  // helm absent: the render suites are describe.skip-ped by helm-required.ts,
  // so there is nothing to fetch and nothing to race on.
  it('no-ops when helm is not on PATH', () => {
    const { spawn, calls } = recordingSpawner();
    expect(ensureChartDependencies({ helm: null, spawn, env: parentEnv() })).toEqual({
      ok: true,
      attempted: false,
      skipped: 'no-helm',
    });
    expect(calls).toEqual([]);
  });
});
