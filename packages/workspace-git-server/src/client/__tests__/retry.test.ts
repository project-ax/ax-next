import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@ax/core';
import {
  isTransientConnectionError,
  TRANSIENT_ERRNOS,
  withRetry,
} from '../retry.js';

// Helpers ------------------------------------------------------------------

function errnoErr(code: string, message = `mock ${code}`): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(message);
  e.code = code;
  return e;
}

function makeFn(
  // Each entry is either a thrown value (rejected) or a resolved value tagged as 'ok'.
  script: ReadonlyArray<{ throws: unknown } | { resolves: unknown }>,
): { fn: () => Promise<unknown>; calls: () => number } {
  let i = 0;
  const fn = async (): Promise<unknown> => {
    const step = script[i++];
    if (step === undefined) {
      throw new Error(`script exhausted at call ${i}`);
    }
    if ('throws' in step) throw step.throws;
    return step.resolves;
  };
  return { fn, calls: () => i };
}

// Drives an in-flight retry loop forward by repeatedly draining microtasks
// and advancing the timer to clear each backoff.  We use `runAllTimersAsync`
// because each setTimeout schedules at a different delay (100, 200, 400, …)
// and we don't want the test to have to know which one fires next.
async function drain(): Promise<void> {
  // Microtasks first — give the inner fn's rejection a chance to land before
  // the loop schedules the next setTimeout. Then advance any pending timer.
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    // If there are no pending timers this is a no-op.
    await vi.runAllTimersAsync();
  }
}

// --------------------------------------------------------------------------
// 1. Transient error retries with exponential backoff
// --------------------------------------------------------------------------

describe('withRetry — exponential backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 100ms, 200ms, 400ms, 800ms… between retries (base 100)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { fn } = makeFn([
      { throws: errnoErr('ECONNREFUSED') },
      { throws: errnoErr('ECONNREFUSED') },
      { throws: errnoErr('ECONNREFUSED') },
      { throws: errnoErr('ECONNREFUSED') },
      { resolves: 'ok' },
    ]);

    const p = withRetry(fn, { maxAttempts: 5, backoffBaseMs: 100 });
    await drain();
    await expect(p).resolves.toBe('ok');

    // Filter out any setTimeout calls not made by our backoff helper. The
    // backoff schedules setTimeout(resolve, wait) with a numeric delay; just
    // collect those numeric delays in order.
    const delays = setTimeoutSpy.mock.calls
      .map((args) => args[1])
      .filter((d): d is number => typeof d === 'number');
    expect(delays).toEqual([100, 200, 400, 800]);

    setTimeoutSpy.mockRestore();
  });

  it('caps backoff at 30000ms', async () => {
    // attempt 8 → 100 * 2^8 = 25600.  attempt 9 → 51200, capped to 30000.
    // attempt 10 → 102400, capped to 30000.  We need at least 11 retries to
    // hit the cap, so feed 11 transient errors followed by success.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const failures = Array.from({ length: 11 }, () => ({
      throws: errnoErr('ECONNREFUSED'),
    }));
    const { fn } = makeFn([...failures, { resolves: 'ok' }]);

    const p = withRetry(fn, { maxAttempts: 11, backoffBaseMs: 100 });
    await drain();
    await expect(p).resolves.toBe('ok');

    const delays = setTimeoutSpy.mock.calls
      .map((args) => args[1])
      .filter((d): d is number => typeof d === 'number');
    // First 9 are uncapped: 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600.
    // Then 51200 -> capped to 30000, 102400 -> capped to 30000.
    expect(delays).toEqual([
      100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000, 30000,
    ]);

    setTimeoutSpy.mockRestore();
  });
});

// --------------------------------------------------------------------------
// 2. Non-retryable error throws immediately (PluginError)
// --------------------------------------------------------------------------

describe('withRetry — PluginError is not retried', () => {
  it('PluginError thrown by inner fn surfaces in 1 attempt', async () => {
    const pe = new PluginError({
      code: 'parent-mismatch',
      plugin: '@ax/test',
      message: 'mismatch',
    });
    const { fn, calls } = makeFn([{ throws: pe }]);

    await expect(
      withRetry(fn, { maxAttempts: 5, backoffBaseMs: 100 }),
    ).rejects.toBe(pe);
    expect(calls()).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 3. Max attempts honored — mirroring the legacy `for (attempt = 0; attempt
//    <= maxRetries; attempt++)` loop.  `maxAttempts: N` means N retries on
//    top of the first try → `N + 1` total tries.  So with `maxAttempts: 3`,
//    4 transient errors all fail and the 4th rethrows.
// --------------------------------------------------------------------------

describe('withRetry — maxAttempts honored', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with maxAttempts: 3, 4 transient errors → final rethrows; total tries = 4', async () => {
    const final = errnoErr('ECONNRESET', 'fourth');
    const { fn, calls } = makeFn([
      { throws: errnoErr('ECONNRESET', 'first') },
      { throws: errnoErr('ECONNRESET', 'second') },
      { throws: errnoErr('ECONNRESET', 'third') },
      { throws: final },
    ]);

    const p = withRetry(fn, { maxAttempts: 3, backoffBaseMs: 100 });
    await drain();
    await expect(p).rejects.toBe(final);
    expect(calls()).toBe(4);
  });

  it('with maxAttempts: 3, 3 transient + success → resolves on attempt 4', async () => {
    const { fn, calls } = makeFn([
      { throws: errnoErr('ECONNRESET') },
      { throws: errnoErr('ECONNRESET') },
      { throws: errnoErr('ECONNRESET') },
      { resolves: 42 },
    ]);

    const p = withRetry(fn, { maxAttempts: 3, backoffBaseMs: 100 });
    await drain();
    await expect(p).resolves.toBe(42);
    expect(calls()).toBe(4);
  });

  it('with maxAttempts: 0, single transient error rethrows immediately (no retries)', async () => {
    const err = errnoErr('ECONNREFUSED');
    const { fn, calls } = makeFn([{ throws: err }]);
    await expect(withRetry(fn, { maxAttempts: 0 })).rejects.toBe(err);
    expect(calls()).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 4. isTransientConnectionError recognizes the documented errnos
// --------------------------------------------------------------------------

describe('isTransientConnectionError', () => {
  it('returns true for each documented transient errno', () => {
    const codes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'EPIPE',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
    ];
    for (const code of codes) {
      expect(isTransientConnectionError(errnoErr(code))).toBe(true);
    }
  });

  it('returns false for non-transient errnos (ENOENT, EACCES, EEXIST)', () => {
    for (const code of ['ENOENT', 'EACCES', 'EEXIST', 'EINVAL']) {
      expect(isTransientConnectionError(errnoErr(code))).toBe(false);
    }
  });

  it('TRANSIENT_ERRNOS contains exactly the documented set', () => {
    expect([...TRANSIENT_ERRNOS].sort()).toEqual(
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'EPIPE',
        'ENOTFOUND',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ETIMEDOUT',
      ].sort(),
    );
  });

  it('returns false for non-Error values (null, undefined, plain object)', () => {
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
    expect(isTransientConnectionError({})).toBe(false);
    expect(isTransientConnectionError('ECONNREFUSED')).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 5. 4xx surfaced as PluginError is NOT retried (already covered above by
//    the 1-attempt assertion; keep an explicit case for the parent-mismatch
//    semantic that the orchestrator keys off of).
// --------------------------------------------------------------------------

describe('withRetry — semantic 4xx via PluginError', () => {
  it('a parent-mismatch PluginError is not retried', async () => {
    const pe = new PluginError({
      code: 'parent-mismatch',
      plugin: '@ax/test',
      message: 'caller parent does not match remote',
      cause: { actualParent: 'abc', expectedParent: 'def' },
    });
    const { fn, calls } = makeFn([{ throws: pe }]);

    await expect(withRetry(fn, { maxAttempts: 5, backoffBaseMs: 100 })).rejects.toBe(pe);
    expect(calls()).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 6. Errors that look transient but aren't (no .code property) are not retried
//    The predicate is structural (errno-based), not message-based.
// --------------------------------------------------------------------------

describe('withRetry — predicate is structural, not message-based', () => {
  it('a generic Error("connection refused") with no .code is not retried', async () => {
    const err = new Error('connection refused');
    const { fn, calls } = makeFn([{ throws: err }]);

    await expect(
      withRetry(fn, { maxAttempts: 5, backoffBaseMs: 100 }),
    ).rejects.toBe(err);
    expect(calls()).toBe(1);
  });

  it('a generic Error("ECONNREFUSED") with no .code is not retried', async () => {
    // Critical regression check: the message contains a transient errno
    // string but the .code property is absent. Message-based matching would
    // (wrongly) retry; errno-based matching (correctly) does not.
    const err = new Error('ECONNREFUSED');
    const { fn, calls } = makeFn([{ throws: err }]);

    await expect(
      withRetry(fn, { maxAttempts: 5, backoffBaseMs: 100 }),
    ).rejects.toBe(err);
    expect(calls()).toBe(1);
  });
});
