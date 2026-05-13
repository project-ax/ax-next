import { describe, it, expect } from 'vitest';
import { withRetry, isTransient } from '../retry.js';

describe('isTransient', () => {
  it('classifies node ETIMEDOUT as transient', () => {
    expect(isTransient(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('classifies ECONNRESET / EPIPE / EAI_AGAIN / undici connect timeout as transient', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']) {
      expect(isTransient(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('classifies HTTP 408/425/429 and any 5xx as transient', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect(isTransient(Object.assign(new Error('x'), { status }))).toBe(true);
    }
  });

  it('classifies SDK-style name strings as transient', () => {
    expect(isTransient(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { name: 'FetchError' }))).toBe(true);
  });

  it('recurses through error.cause', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ETIMEDOUT' });
    const outer = Object.assign(new Error('outer'), { cause: inner });
    expect(isTransient(outer)).toBe(true);
  });

  it('rejects 4xx and unknown errors as non-transient', () => {
    expect(isTransient(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false);
    expect(isTransient(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false);
    expect(isTransient(Object.assign(new Error('not found'), { status: 404 }))).toBe(false);
    expect(isTransient(new Error('plain error'))).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return 42;
      },
      { attempts: 3, baseDelayMs: 1, label: 'test', log: () => {} },
    );
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
        return 'ok';
      },
      { attempts: 4, baseDelayMs: 1, label: 'test', log: () => {} },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error('nope'), { status: 400 });
        },
        { attempts: 3, baseDelayMs: 1, label: 'test', log: () => {} },
      ),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });

  it('exhausts attempts then re-throws the last transient error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error(`boom ${calls}`), { code: 'ETIMEDOUT' });
        },
        { attempts: 3, baseDelayMs: 1, label: 'test', log: () => {} },
      ),
    ).rejects.toThrow('boom 3');
    expect(calls).toBe(3);
  });
});
