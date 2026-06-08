import { describe, expect, it } from 'vitest';
import { createLogger } from '@ax/core';
import { isPodGoneError, isTransientApiError, killPod } from '../kill.js';
import { makeMockK8sApi } from './mock-k8s.js';

const silentLogger = createLogger({ reqId: 'test', writer: () => undefined });

// No-wait sleep seam so retry tests don't actually pause.
const noSleep = (): Promise<void> => Promise.resolve();

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

  it('propagates a permanent (non-404, non-transient) error after a SINGLE attempt', async () => {
    const api = makeMockK8sApi();
    // A 403 is permanent — retrying it just hammers the apiserver.
    api.setDeleteError({ statusCode: 403, body: 'forbidden' });
    await expect(
      killPod({
        api,
        podName: 'p',
        namespace: 'n',
        podLog: silentLogger,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // No retry on a permanent error.
    expect(api.deletes).toHaveLength(1);
  });

  it('retries a transient 500 then succeeds (the TASK-170 regression)', async () => {
    const api = makeMockK8sApi();
    // The observed GKE-Standard shape: HTTP 500 carrying `code = Unavailable`.
    api.setDeleteErrors({
      statusCode: 500,
      body: "rpc error: code = Unavailable ... 'Txn' throttled ... (memory-protection)",
    });
    await expect(
      killPod({
        api,
        podName: 'p',
        namespace: 'n',
        podLog: silentLogger,
        sleep: noSleep,
      }),
    ).resolves.toBeUndefined();
    // First attempt threw (transient), second succeeded.
    expect(api.deletes).toHaveLength(2);
  });

  it('rethrows after exhausting retries when the transient error persists', async () => {
    const api = makeMockK8sApi();
    // Persistent transient error — fail every attempt.
    api.setDeleteErrors(
      { statusCode: 503 },
      { statusCode: 503 },
      { statusCode: 503 },
      { statusCode: 503 },
    );
    await expect(
      killPod({
        api,
        podName: 'p',
        namespace: 'n',
        podLog: silentLogger,
        sleep: noSleep,
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    // Exactly maxAttempts delete calls — bounded.
    expect(api.deletes).toHaveLength(3);
  });
});

describe('isTransientApiError', () => {
  it('is true for 5xx in code / statusCode / response.statusCode', () => {
    expect(isTransientApiError({ statusCode: 500 })).toBe(true);
    expect(isTransientApiError({ code: 503 })).toBe(true);
    expect(isTransientApiError({ response: { statusCode: 599 } })).toBe(true);
  });
  it('is true for an Unavailable / throttled / overloaded message or body', () => {
    expect(
      isTransientApiError({ body: 'rpc error: code = Unavailable' }),
    ).toBe(true);
    expect(isTransientApiError(new Error('Task is overloaded'))).toBe(true);
    expect(isTransientApiError({ message: 'request throttled' })).toBe(true);
  });
  it('is false for 404 (happy path — not a retry case)', () => {
    expect(isTransientApiError({ statusCode: 404 })).toBe(false);
  });
  it('is false for other 4xx (permanent)', () => {
    expect(isTransientApiError({ statusCode: 403 })).toBe(false);
    expect(isTransientApiError({ statusCode: 400, body: 'bad request' })).toBe(false);
  });
  it('is false for null / non-object / unrelated', () => {
    expect(isTransientApiError(null)).toBe(false);
    expect(isTransientApiError('boom')).toBe(false);
    expect(isTransientApiError(new Error('some unrelated failure'))).toBe(false);
  });
});
