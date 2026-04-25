import { describe, expect, it } from 'vitest';
import { createLogger } from '@ax/core';
import { isPodGoneError, killPod } from '../kill.js';
import { makeMockK8sApi } from './mock-k8s.js';

const silentLogger = createLogger({ reqId: 'test', writer: () => undefined });

describe('isPodGoneError', () => {
  it('returns true for code:404', () => {
    expect(isPodGoneError({ code: 404 })).toBe(true);
  });
  it('returns true for statusCode:404', () => {
    expect(isPodGoneError({ statusCode: 404 })).toBe(true);
  });
  it('returns true for response.statusCode:404', () => {
    expect(isPodGoneError({ response: { statusCode: 404 } })).toBe(true);
  });
  it('returns true for body matching /not found/i', () => {
    expect(isPodGoneError({ body: 'pods "x" Not Found' })).toBe(true);
  });
  it('returns false for an unrelated error', () => {
    expect(isPodGoneError(new Error('apiserver flaked'))).toBe(false);
    expect(isPodGoneError({ code: 500 })).toBe(false);
    expect(isPodGoneError(null)).toBe(false);
    expect(isPodGoneError('string err')).toBe(false);
  });
});

describe('killPod', () => {
  it('sends deleteNamespacedPod with gracePeriodSeconds:5 by default', async () => {
    const api = makeMockK8sApi();
    await killPod({
      api,
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
    });
    expect(api.deletes).toEqual([
      { name: 'p', namespace: 'n', gracePeriodSeconds: 5 },
    ]);
  });

  it('honors a custom gracePeriodSeconds', async () => {
    const api = makeMockK8sApi();
    await killPod({
      api,
      podName: 'p',
      namespace: 'n',
      podLog: silentLogger,
      gracePeriodSeconds: 0,
    });
    expect(api.deletes[0]!.gracePeriodSeconds).toBe(0);
  });

  it('resolves successfully on 404 (idempotent — pod already gone)', async () => {
    const api = makeMockK8sApi();
    api.setDeleteError({ code: 404, body: 'not found' });
    await expect(
      killPod({
        api,
        podName: 'p',
        namespace: 'n',
        podLog: silentLogger,
      }),
    ).resolves.toBeUndefined();
  });

  it('propagates non-404 errors', async () => {
    const api = makeMockK8sApi();
    api.setDeleteError(new Error('apiserver down'));
    await expect(
      killPod({
        api,
        podName: 'p',
        namespace: 'n',
        podLog: silentLogger,
      }),
    ).rejects.toThrow(/apiserver down/);
  });
});
