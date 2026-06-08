import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@ax/core';
import { RUNNER_COMPONENT_SELECTOR, sweepOrphanedPods, startOrphanSweeper } from '../sweep.js';
import { makeMockK8sApi, type MockPod } from './mock-k8s.js';

const silentLogger = createLogger({ reqId: 'test', writer: () => undefined });
const NOW = 1_000_000_000_000; // fixed clock for age math
const MIN = 60_000;

function pod(
  name: string,
  phase: string | undefined,
  ageMs: number,
): MockPod {
  return {
    metadata: {
      name,
      namespace: 'ax-next',
      // creationTimestamp is a Date on the real V1Pod.
      creationTimestamp: new Date(NOW - ageMs),
    } as MockPod['metadata'],
    status: phase === undefined ? {} : { phase },
  };
}

describe('sweepOrphanedPods', () => {
  it('deletes a STALE terminal pod but leaves a Running one and a YOUNG terminal one', async () => {
    const api = makeMockK8sApi();
    api.setListResponses(
      pod('stale-succeeded', 'Succeeded', 30 * MIN), // old + terminal → reap
      pod('stale-failed', 'Failed', 30 * MIN), // old + terminal → reap
      pod('running', 'Running', 30 * MIN), // not terminal → keep
      pod('young-succeeded', 'Succeeded', 1 * MIN), // terminal but young → keep
    );
    const reaped = await sweepOrphanedPods({
      api,
      namespace: 'ax-next',
      terminalAgeMs: 10 * MIN,
      now: () => NOW,
      podLog: silentLogger,
    });
    expect(reaped).toBe(2);
    const deletedNames = api.deletes.map((d) => d.name).sort();
    expect(deletedNames).toEqual(['stale-failed', 'stale-succeeded']);
  });

  it('scopes the list to runner pods via the component labelSelector', async () => {
    const api = makeMockK8sApi();
    api.setListResponses();
    await sweepOrphanedPods({
      api,
      namespace: 'ax-next',
      terminalAgeMs: 10 * MIN,
      now: () => NOW,
      podLog: silentLogger,
    });
    expect(api.lists).toHaveLength(1);
    expect(api.lists[0]!.namespace).toBe('ax-next');
    expect(api.lists[0]!.labelSelector).toBe(RUNNER_COMPONENT_SELECTOR);
  });

  it('returns 0 and does not throw when the list call fails', async () => {
    const api = makeMockK8sApi();
    api.setListError(new Error('apiserver flaked'));
    const reaped = await sweepOrphanedPods({
      api,
      namespace: 'ax-next',
      terminalAgeMs: 10 * MIN,
      now: () => NOW,
      podLog: silentLogger,
    });
    expect(reaped).toBe(0);
    expect(api.deletes).toHaveLength(0);
  });

  it('swallows a per-pod delete failure and continues to the rest', async () => {
    const api = makeMockK8sApi();
    api.setListResponses(
      pod('reap-1', 'Succeeded', 30 * MIN),
      pod('reap-2', 'Failed', 30 * MIN),
    );
    // First delete fails permanently; the sweep must still attempt the second
    // and not throw. killPod uses gracePeriodSeconds 0 here, default attempts.
    api.setDeleteErrors({ statusCode: 403, body: 'forbidden' });
    const reaped = await sweepOrphanedPods({
      api,
      namespace: 'ax-next',
      terminalAgeMs: 10 * MIN,
      now: () => NOW,
      podLog: silentLogger,
    });
    // One succeeded, one failed → counted reaped is 1.
    expect(reaped).toBe(1);
    // Both were attempted.
    expect(api.deletes.map((d) => d.name).sort()).toEqual(['reap-1', 'reap-2']);
  });

  it('ignores a terminal pod missing a creationTimestamp (cannot age it → keep)', async () => {
    const api = makeMockK8sApi();
    const p = pod('no-ts', 'Succeeded', 30 * MIN);
    delete (p.metadata as { creationTimestamp?: unknown }).creationTimestamp;
    api.setListResponses(p);
    const reaped = await sweepOrphanedPods({
      api,
      namespace: 'ax-next',
      terminalAgeMs: 10 * MIN,
      now: () => NOW,
      podLog: silentLogger,
    });
    expect(reaped).toBe(0);
    expect(api.deletes).toHaveLength(0);
  });
});

describe('startOrphanSweeper', () => {
  it('runs once at startup, again on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const api = makeMockK8sApi();
      api.setListResponses();
      const handle = startOrphanSweeper({
        api,
        namespace: 'ax-next',
        intervalMs: 5 * MIN,
        terminalAgeMs: 10 * MIN,
        podLog: silentLogger,
      });
      // Startup sweep is fired synchronously; let its microtasks settle.
      await vi.advanceTimersByTimeAsync(0);
      expect(api.lists).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(api.lists).toHaveLength(2);

      await handle.stop();
      await vi.advanceTimersByTimeAsync(5 * MIN);
      // No further lists after stop.
      expect(api.lists).toHaveLength(2);

      // Idempotent stop.
      await expect(handle.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on a non-positive interval (misconfiguration)', () => {
    const api = makeMockK8sApi();
    expect(() =>
      startOrphanSweeper({
        api,
        namespace: 'ax-next',
        intervalMs: 0,
        terminalAgeMs: 10 * MIN,
        podLog: silentLogger,
      }),
    ).toThrow(/intervalMs/);
  });
});
