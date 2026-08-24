// Observes the LIVE run: the once-per-run fetch really did happen in
// globalSetup, and the "already done" fact really did reach this worker.
//
// helm-deps.test.ts proves the once-semantics against an injected spawner.
// This file proves the wiring those semantics rest on, which no fake can
// check: vitest runs globalSetup in its parent process and test files in
// worker processes, so the module-level flag in helm-deps.ts is worthless
// across the boundary — one flag per worker was the original bug shape. The
// `AX_CHART_DEPS_SYNCED` marker is what crosses it, by inheritance, and if
// vitest ever stopped propagating the parent's env to workers this test is
// what would say so (rather than the chart suite quietly going back to one
// fetch per file).
//
// Runs with or without helm on PATH: the marker is stamped either way, because
// "the run-level fetch step has executed" is true even when there was nothing
// to fetch.

import { describe, expect, it } from 'vitest';

import {
  CHART_DEPS_SYNCED_ENV,
  ensureChartDependencies,
  type HelmSpawner,
} from './helm-deps.js';

describe('run-level chart dependency fetch', () => {
  it('globalSetup ran in the parent and the marker reached this worker', () => {
    expect(process.env[CHART_DEPS_SYNCED_ENV]).toBe('1');
  });

  it('a call from inside a test worker spawns nothing', () => {
    const calls: string[] = [];
    const spawn: HelmSpawner = (_file, args) => {
      calls.push(args.join(' '));
      return { status: 0, stdout: '' };
    };
    // Deliberately the real `process.env` — that is the inherited marker.
    expect(ensureChartDependencies({ helm: 'helm', spawn })).toEqual({
      ok: true,
      attempted: false,
    });
    expect(calls).toEqual([]);
  });
});
