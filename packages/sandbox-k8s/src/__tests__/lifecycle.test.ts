import { describe, expect, it } from 'vitest';
import { createLogger } from '@ax/core';
import { waitForPodReady, watchPodExit } from '../lifecycle.js';
import { makeMockK8sApi } from './mock-k8s.js';

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
