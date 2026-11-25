import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createSandboxK8sPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';
import { makeMockK8sApi, type MockK8sApi } from './mock-k8s.js';
import { TEST_PROXY_CONFIG } from './proxy-config.js';

// ---------------------------------------------------------------------------
// TASK-1240 — the `sandbox:open-session` bus timeout must outlast the readiness
// wait it backs up. With the DEFAULT readiness values (60 s + 120 s per
// service) three services give a 420 s wait; the bus used to give up at a fixed
// 300 s, so the caller got a bare `timeout` while the pod lived on and the
// named service diagnosis was never delivered. These run on fake clocks so a
// ten-minute open takes milliseconds.
// ---------------------------------------------------------------------------

const TEST_HOST_IPC_URL = 'http://test-host:8080';
const PINNED_SVC_IMAGE = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

const service = (name: string, port: number) => ({
  name,
  image: PINNED_SVC_IMAGE,
  ports: [port],
  env: {},
  writablePaths: [],
});

async function makeHarness(api: MockK8sApi) {
  return createTestHarness({
    plugins: [
      createSessionInmemoryPlugin(),
      createSandboxK8sPlugin({
        api,
        namespace: 'ax-test',
        image: 'ax-next/agent:test',
        hostIpcUrl: TEST_HOST_IPC_URL,
        readinessPollMs: 10_000,
        orphanSweepIntervalMs: 0,
      }),
    ],
  });
}

function openThreeServices(h: Awaited<ReturnType<typeof makeHarness>>, sessionId: string) {
  return h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', h.ctx(), {
    sessionId,
    workspaceRoot: '/tmp/ws',
    runnerBinary: '/opt/ax/runner.js',
    proxyConfig: TEST_PROXY_CONFIG,
    services: [service('redis', 6379), service('postgres', 5432), service('seed', 5433)],
  });
}

function fakeClocks() {
  // `Date` must be faked: waitForPodReady's deadline reads Date.now. Leave
  // setImmediate real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

describe('sandbox:open-session bus clock vs readiness wait (TASK-1240)', () => {
  afterEach(() => vi.useRealTimers());

  it('three services that never become ready: the caller gets the named diagnosis, not the bus timeout, and the pod is already gone (TASK-1240)', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: {
        phase: 'Pending',
        initContainerStatuses: [
          { name: 'svc-postgres', state: { waiting: { reason: 'CrashLoopBackOff' } } },
        ],
      },
    });
    api.setLogResponse(
      'svc-postgres',
      'mkdir: cannot create directory /var/lib/postgresql/data/pgdata: Permission denied',
    );
    const h = await makeHarness(api);
    fakeClocks();

    let settled = false;
    let rejection: unknown;
    const open = openThreeServices(h, 'sess-clock-fail').then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        rejection = err;
      },
    );

    // Past the OLD fixed 300 s bus clock: the readiness wait (420 s) is still
    // running, so nothing has settled and the pod has not been deleted.
    await vi.advanceTimersByTimeAsync(300_001);
    expect(settled).toBe(false);
    expect(api.deletes).toHaveLength(0);

    // Past the readiness budget: the named diagnosis arrives and the pod goes.
    await vi.advanceTimersByTimeAsync(130_000);
    await open;
    expect(settled).toBe(true);
    expect(rejection).toMatchObject({
      code: 'service-sidecar-failed',
      diagnosis: {
        service: 'postgres',
        path: '/var/lib/postgresql/data/pgdata',
        reason: 'permission denied',
      },
    });
    expect(api.deletes.length).toBeGreaterThan(0);
  });

  it('a healthy three-service stack that needs more than 300 s still opens (TASK-1240)', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(
      ...Array.from({ length: 35 }, () => ({ status: { phase: 'Pending' } })),
      {
        status: {
          phase: 'Running',
          podIP: '10.0.0.9',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    );
    const h = await makeHarness(api);
    fakeClocks();

    let settled = false;
    const open = openThreeServices(h, 'sess-clock-ok');
    open.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(300_001);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await open;
    expect(result.runnerEndpoint).toBe(TEST_HOST_IPC_URL);
    await result.handle.kill();
  });
});
