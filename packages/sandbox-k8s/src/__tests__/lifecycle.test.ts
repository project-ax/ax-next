import { describe, expect, it } from 'vitest';
import { createLogger } from '@ax/core';
import {
  diagnoseServiceSidecars,
  waitForPodReady,
  watchPodExit,
} from '../lifecycle.js';
import { makeMockK8sApi, type MockPod } from './mock-k8s.js';

const silentLogger = createLogger({ reqId: 'test', writer: () => undefined });

describe('lifecycle.waitForPodReady', () => {
  it('returns podIP once Ready=True', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(
      { status: { phase: 'Pending', conditions: [] } },
      {
        status: {
          phase: 'Running',
          podIP: '10.0.0.1',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    );
    const result = await waitForPodReady({
      api,
      podName: 'p',
      namespace: 'n',
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      podLog: silentLogger,
    });
    expect(result.podIP).toBe('10.0.0.1');
  });

  it('throws PluginError(pod-failed-before-ready) when phase=Failed', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: { phase: 'Failed', reason: 'ImagePullBackOff' },
    });
    await expect(
      waitForPodReady({
        api,
        podName: 'p',
        namespace: 'n',
        pollIntervalMs: 1,
        timeoutMs: 1_000,
        podLog: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'pod-failed-before-ready' });
  });

  it('throws PluginError(pod-readiness-timeout) after deadline', async () => {
    const api = makeMockK8sApi();
    // Always Pending — never Ready. Tight timeout makes the test fast.
    api.setReadResponses({ status: { phase: 'Pending', conditions: [] } });
    await expect(
      waitForPodReady({
        api,
        podName: 'p',
        namespace: 'n',
        pollIntervalMs: 1,
        timeoutMs: 30,
        podLog: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'pod-readiness-timeout' });
  });
});

describe('lifecycle.watchPodExit reason capture', () => {
  it('container-level reason: terminated.reason=OOMKilled', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'runner',
            state: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
          },
        ],
      },
    });
    const exit = await watchPodExit({
      api,
      podName: 'p',
      namespace: 'n',
      pollIntervalMs: 1,
      podLog: silentLogger,
    });
    expect(exit.reason).toBe('OOMKilled');
    expect(exit.code).toBe(137);
  });

  it('pod-level reason wins: status.reason=Evicted overrides container reason', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: {
        phase: 'Failed',
        reason: 'Evicted',
        message: 'node out of disk',
        containerStatuses: [
          {
            name: 'runner',
            state: { terminated: { exitCode: 1, reason: 'Error' } },
          },
        ],
      },
    });
    const exit = await watchPodExit({
      api,
      podName: 'p',
      namespace: 'n',
      pollIntervalMs: 1,
      podLog: silentLogger,
    });
    expect(exit.reason).toBe('Evicted');
  });

  it('Succeeded phase yields exit info with reason=unknown when no terminated state present', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: {
        phase: 'Succeeded',
        containerStatuses: [{ name: 'runner', state: {} }],
      },
    });
    const exit = await watchPodExit({
      api,
      podName: 'p',
      namespace: 'n',
      pollIntervalMs: 1,
      podLog: silentLogger,
    });
    expect(exit.reason).toBe('unknown');
    expect(exit.code).toBeNull();
  });

  it('returns "pod-gone" when read returns 404', async () => {
    const api = makeMockK8sApi();
    api.setReadError({ code: 404 });
    const exit = await watchPodExit({
      api,
      podName: 'p',
      namespace: 'n',
      pollIntervalMs: 1,
      podLog: silentLogger,
    });
    expect(exit.reason).toBe('pod-gone');
  });
});

describe('lifecycle.diagnoseServiceSidecars (TASK-160)', () => {
  const crashloopedKafkaPod: MockPod = {
    status: {
      phase: 'Pending',
      initContainerStatuses: [
        // The sdk-scaffold init container succeeded.
        { name: 'sdk-scaffold', state: { terminated: { exitCode: 0 } } },
        // The kafka sidecar is crashlooping.
        {
          name: 'svc-kafka',
          state: { waiting: { reason: 'CrashLoopBackOff' } },
        },
      ],
    },
  };

  it('names the service + offending path from a crashlooped sidecar log (EROFS)', async () => {
    const api = makeMockK8sApi();
    api.setLogResponse(
      'svc-kafka',
      'starting kafka...\nmkdir: cannot create directory /opt/kafka/logs: Read-only file system',
    );
    const diagnosis = await diagnoseServiceSidecars({
      api,
      pod: crashloopedKafkaPod,
      podName: 'ax-sandbox-abc',
      namespace: 'ax',
      podLog: silentLogger,
    });
    expect(diagnosis).toEqual({
      service: 'kafka',
      path: '/opt/kafka/logs',
      reason: 'read-only filesystem',
    });
    // It read a BOUNDED tail (tailLines set) and tried the previous instance.
    expect(api.logReads[0]).toMatchObject({
      container: 'svc-kafka',
      tailLines: 20,
      previous: true,
    });
  });

  it('diagnoses from terminated.message WITHOUT a pods/log API call (no RBAC needed)', async () => {
    const api = makeMockK8sApi();
    // No log stubbed — if the diagnoser called readNamespacedPodLog it would
    // throw. The kubelet (FallbackToLogsOnError) put the log tail in
    // terminated.message, so we read it from the status we already have.
    const diagnosis = await diagnoseServiceSidecars({
      api,
      pod: {
        status: {
          phase: 'Pending',
          initContainerStatuses: [
            {
              name: 'svc-postgres',
              state: {
                terminated: {
                  exitCode: 1,
                  reason: 'Error',
                  message:
                    'initdb: error: could not create directory "/var/lib/postgresql/data": Read-only file system',
                },
              },
            },
          ],
        },
      },
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
    });
    expect(diagnosis).toEqual({
      service: 'postgres',
      path: '/var/lib/postgresql/data',
      reason: 'read-only filesystem',
    });
    // Crucially: the API log endpoint was NEVER hit (capability not exercised).
    expect(api.logReads).toHaveLength(0);
  });

  it('falls back to the current log when the previous-instance read throws', async () => {
    const api = makeMockK8sApi();
    // Only the CURRENT log is stubbed; the `previous:true` read throws first.
    let calls = 0;
    const realReadLog = api.readNamespacedPodLog.bind(api);
    api.setLogResponse('svc-mongo', 'open /data/db: permission denied');
    api.readNamespacedPodLog = async (req) => {
      calls += 1;
      if (calls === 1 && req.previous === true) {
        throw new Error('previous terminated container not found');
      }
      return realReadLog({ ...req, previous: false });
    };
    const diagnosis = await diagnoseServiceSidecars({
      api,
      pod: {
        status: {
          phase: 'Pending',
          initContainerStatuses: [
            { name: 'svc-mongo', state: { terminated: { exitCode: 1, reason: 'Error' } } },
          ],
        },
      },
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
    });
    expect(diagnosis).toEqual({
      service: 'mongo',
      path: '/data/db',
      reason: 'permission denied',
    });
  });

  it('returns undefined when no sidecar is failing', async () => {
    const api = makeMockK8sApi();
    const diagnosis = await diagnoseServiceSidecars({
      api,
      pod: {
        status: {
          phase: 'Pending',
          initContainerStatuses: [
            { name: 'sdk-scaffold', state: { terminated: { exitCode: 0 } } },
            { name: 'svc-kafka', state: { waiting: { reason: 'PodInitializing' } } },
          ],
        },
      },
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
    });
    expect(diagnosis).toBeUndefined();
    // No log read attempted for a healthy/initializing sidecar.
    expect(api.logReads).toHaveLength(0);
  });

  it('returns a reason without a path when the log is unparseable', async () => {
    const api = makeMockK8sApi();
    api.setLogResponse('svc-redis', 'exited unexpectedly with status 1');
    const diagnosis = await diagnoseServiceSidecars({
      api,
      pod: {
        status: {
          phase: 'Pending',
          initContainerStatuses: [
            { name: 'svc-redis', state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      },
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
    });
    expect(diagnosis).toEqual({ service: 'redis', reason: 'startup failed' });
  });

  it('is best-effort: returns undefined (never throws) when BOTH log reads fail', async () => {
    const api = makeMockK8sApi();
    // No log stubbed → both reads throw; diagnosis still produced w/o a path,
    // because we still know which sidecar failed.
    const diagnosis = await diagnoseServiceSidecars({
      api,
      pod: {
        status: {
          initContainerStatuses: [
            { name: 'svc-kafka', state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      },
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
    });
    expect(diagnosis).toEqual({ service: 'kafka', reason: 'startup failed' });
  });
});
