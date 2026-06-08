import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createSandboxK8sPlugin } from '../plugin.js';
import { RUNNER_COMPONENT_SELECTOR } from '../sweep.js';
import { makeMockK8sApi, type MockK8sApi } from './mock-k8s.js';

// ---------------------------------------------------------------------------
// Plugin lifecycle — the TASK-170 orphan-sweep wiring.
//
// init() starts the periodic sweeper (label-scoped list against the cluster);
// shutdown() (driven here via the harness's close()) stops it. We use fake
// timers so the periodic tick is deterministic and fast.
// ---------------------------------------------------------------------------

const TEST_HOST_IPC_URL = 'http://test-host:8080';
const SWEEP_INTERVAL_MS = 300_000;

async function makeHarness(api: MockK8sApi, orphanSweepIntervalMs: number) {
  return createTestHarness({
    plugins: [
      createSessionInmemoryPlugin(),
      createSandboxK8sPlugin({
        api,
        namespace: 'ax-test',
        hostIpcUrl: TEST_HOST_IPC_URL,
        orphanSweepIntervalMs,
        orphanSweepTerminalAgeMs: 600_000,
      }),
    ],
  });
}

describe('createSandboxK8sPlugin orphan-sweep lifecycle', () => {
  it('starts the sweeper at init (label-scoped) and stops it on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const api = makeMockK8sApi();
      api.setListResponses();
      const h = await makeHarness(api, SWEEP_INTERVAL_MS);

      // Startup sweep fired during init.
      await vi.advanceTimersByTimeAsync(0);
      expect(api.lists).toHaveLength(1);
      expect(api.lists[0]!.labelSelector).toBe(RUNNER_COMPONENT_SELECTOR);
      expect(api.lists[0]!.namespace).toBe('ax-test');

      // Periodic tick.
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(api.lists).toHaveLength(2);

      // shutdown() (reverse-order via close) clears the timer.
      await h.close();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
      expect(api.lists).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT start a sweeper when orphanSweepIntervalMs <= 0', async () => {
    vi.useFakeTimers();
    try {
      const api = makeMockK8sApi();
      api.setListResponses();
      const h = await makeHarness(api, 0);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
      expect(api.lists).toHaveLength(0);

      // shutdown with no sweeper is a clean no-op.
      await expect(h.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
