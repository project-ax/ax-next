import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  ReadUserFilesInput,
  ReadUserFilesOutput,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
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

// ---------------------------------------------------------------------------
// TASK-167 (§11) — the host-read hook registration + the agents:deleted
// cleanup-subscriber wiring. We register a minimal nfs resolver alongside the
// k8s plugin and drive the bus end to end (sweeper disabled).
// ---------------------------------------------------------------------------

/** A bare plugin that registers an nfs `sandbox:resolve-mounts` resolver. */
function nfsResolverPlugin(): Plugin {
  return {
    manifest: {
      name: 'test-nfs-resolver',
      version: '0.0.0',
      registers: ['sandbox:resolve-mounts'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
        'sandbox:resolve-mounts',
        'test-nfs-resolver',
        async (_c, input) => ({
          mounts: input.owner.agentId
            ? [
                {
                  kind: 'nfs',
                  mountPath: '/workspace',
                  server: '10.0.0.2',
                  exportPath: '/vol1/agents',
                  subPath: input.owner.agentId,
                  readOnly: input.readOnly === true,
                  role: 'user-files',
                },
              ]
            : [],
        }),
      );
    },
  };
}

describe('createSandboxK8sPlugin — §11 host-read + cleanup wiring', () => {
  async function makeWiredHarness(api: MockK8sApi) {
    return createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        nfsResolverPlugin(),
        createSandboxK8sPlugin({
          api,
          namespace: 'ax-test',
          hostIpcUrl: TEST_HOST_IPC_URL,
          orphanSweepIntervalMs: 0, // no sweeper noise
          orphanSweepTerminalAgeMs: 600_000,
        }),
      ],
    });
  }

  function primeTerminal(api: MockK8sApi, log?: string) {
    api.setReadResponses({
      status: {
        phase: 'Succeeded',
        containerStatuses: [
          { name: 'userfiles', state: { terminated: { exitCode: 0 } } },
        ],
      },
    });
    if (log !== undefined) api.setLogResponse('userfiles', log);
  }

  it('registers sandbox:read-user-files', async () => {
    const api = makeMockK8sApi();
    const h = await makeWiredHarness(api);
    expect(h.bus.hasService('sandbox:read-user-files')).toBe(true);
    await h.close();
  });

  it('agents:deleted fires a one-shot cleanup pod scoped to the deleted agent', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api);
    const h = await makeWiredHarness(api);

    const fired = await h.bus.fire('agents:deleted', h.ctx(), {
      agentId: 'agt_DeleteMe',
      ownerId: 'user-1',
      ownerType: 'user',
    });
    expect(fired.rejected).toBe(false);

    // Exactly one cleanup pod, scoped to this agent's subPath.
    expect(api.creates).toHaveLength(1);
    const pod = api.creates[0]!.body as {
      metadata: { labels: Record<string, string> };
      spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    };
    expect(pod.metadata.labels['ax.io/plane']).toBe('execution');
    expect(pod.spec.containers[0]!.env).toEqual([
      { name: 'SUBPATH', value: 'agt_DeleteMe' },
    ]);
    await h.close();
  });

  it('sandbox:read-user-files runs a read pod and parses its log output', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'FILE ' + Buffer.from('hello').toString('base64'));
    const h = await makeWiredHarness(api);

    const out = await h.bus.call<ReadUserFilesInput, ReadUserFilesOutput>(
      'sandbox:read-user-files',
      h.ctx(),
      {
        owner: {
          userId: 'user-1',
          agentId: 'agt_Reader',
          agentConfig: {
            displayName: '',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: '',
          },
        },
        relPath: 'hello.txt',
      },
    );
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('hello');
    await h.close();
  });
});
