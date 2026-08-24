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
//   2. Once ACROSS processes — the `AX_CHART_DEPS_SYNCED` marker. globalSetup
//      runs in vitest's parent and workers inherit its env, so a stray call
//      from inside a test file finds the marker and does nothing. The companion
//      assertion that the marker really does reach a worker is in
//      global-setup-once.test.ts, which observes the live run.
//
// The source-shape half of the guard — that no test file grows its own copy of
// the fetch again — lives in
// scripts/__tests__/helm-dependency-sync-single-source.test.js.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BITNAMI_REPO,
  BITNAMI_URL,
  CHART_DEPS_SYNCED_ENV,
  ensureChartDependencies,
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

/** A fresh env per test — never the real `process.env`. */
function freshEnv(): Record<string, string | undefined> {
  return {};
}

beforeEach(() => {
  resetChartDependencyStateForTests();
});

describe('ensureChartDependencies: at most one fetch per run', () => {
  it('repeated calls in one process spawn the fetch exactly once', () => {
    const { spawn, calls } = recordingSpawner();
    const env = freshEnv();

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

  it('reports attempted:true on the first call and false afterwards', () => {
    const { spawn } = recordingSpawner();
    const env = freshEnv();
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: true,
    });
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: false,
    });
  });

  // The cross-process half. A worker inherits the parent's env, so a call from
  // inside a test file must not touch the shared helm cache at all.
  it('short-circuits when the run-level marker is already in the env', () => {
    const { spawn, calls } = recordingSpawner();
    const env = { [CHART_DEPS_SYNCED_ENV]: '1' };

    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: false,
    });
    expect(calls).toEqual([]);
  });

  it('stamps the marker so a child process short-circuits', () => {
    const { spawn } = recordingSpawner();
    const env = freshEnv();
    ensureChartDependencies({ helm: 'helm', spawn, env });
    expect(env[CHART_DEPS_SYNCED_ENV]).toBe('1');
  });

  // "One attempt, win or lose." Marking only on success would let a failure
  // re-enter the fetch — which is how the old 3x retry rebuilt the very
  // contention it was retrying around.
  it('does not retry after a failure, and still marks the run as attempted', () => {
    const { spawn, calls } = recordingSpawner({
      failOn: (args) => args[0] === 'dependency',
    });
    const env = freshEnv();

    const first = ensureChartDependencies({ helm: 'helm', spawn, env });
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.reason).toContain('helm dependency build exit 1');

    const spawnsAfterFailure = calls.length;
    expect(ensureChartDependencies({ helm: 'helm', spawn, env })).toEqual({
      ok: true,
      attempted: false,
    });
    expect(calls.length).toBe(spawnsAfterFailure);
  });

  it('never passes --force-update', () => {
    const { spawn, calls } = recordingSpawner();
    ensureChartDependencies({ helm: 'helm', spawn, env: freshEnv() });
    expect(calls.flatMap((c) => c.args)).not.toContain('--force-update');
  });
});

describe('ensureChartDependencies: which single helm call it makes', () => {
  it('registers the repo when bitnami is absent (fresh CI runner)', () => {
    const { spawn, calls } = recordingSpawner({ stdout: '[]' });
    ensureChartDependencies({ helm: 'helm', spawn, env: freshEnv() });
    expect(calls[1]!.args).toEqual(['repo', 'add', BITNAMI_REPO, BITNAMI_URL]);
  });

  // Already registered: `add` without `--force-update` would error, and forcing
  // is what we deleted. `update` re-downloads just the index — which also
  // repairs the stale/empty cached index the old flag was covering for.
  it('refreshes the index when bitnami is already registered (dev box)', () => {
    const { spawn, calls } = recordingSpawner({
      stdout: JSON.stringify([{ name: BITNAMI_REPO, url: BITNAMI_URL }]),
    });
    ensureChartDependencies({ helm: 'helm', spawn, env: freshEnv() });
    expect(calls[1]!.args).toEqual(['repo', 'update', BITNAMI_REPO]);
  });

  it('surfaces a repo-refresh failure with helm stderr, not a timeout', () => {
    const { spawn } = recordingSpawner({
      stdout: '[]',
      failOn: (args) => args[0] === 'repo' && args[1] === 'add',
    });
    const out = ensureChartDependencies({ helm: 'helm', spawn, env: freshEnv() });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe(
      `helm repo add ${BITNAMI_REPO} exit 1: boom`,
    );
  });

  // helm absent: the render suites are describe.skip-ped by helm-required.ts,
  // so there is nothing to fetch and nothing to race on.
  it('no-ops when helm is not on PATH', () => {
    const { spawn, calls } = recordingSpawner();
    const env = freshEnv();
    expect(ensureChartDependencies({ helm: null, spawn, env })).toEqual({
      ok: true,
      attempted: false,
    });
    expect(calls).toEqual([]);
    expect(env[CHART_DEPS_SYNCED_ENV]).toBe('1');
  });
});
