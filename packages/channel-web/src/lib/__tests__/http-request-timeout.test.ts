/**
 * `withRequestTimeout` (TASK-937): one request, fetch to body, with a deadline.
 * The task page and the routine calls wrap their requests in it, so a request
 * that never answers ends as an ordinary failure instead of holding a button
 * disabled and a poll stopped for good. The ordering matters: the timer
 * rejects BEFORE it aborts, so the caller sees the timeout and not the abort
 * the timeout itself caused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HTTP_FAILED,
  HttpError,
  httpFetch,
  isConfirmedRefusal,
  REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  userFacingMessage,
  withRequestTimeout,
} from '../http';
import { toReadOutcome } from '../read-register';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withRequestTimeout', () => {
  it('rejects with a RequestTimeoutError at the deadline when the request never answers, and aborts its signal with it', async () => {
    let signal: AbortSignal | undefined;
    const result = withRequestTimeout('/x', 1000, (s) => {
      signal = s;
      return new Promise<never>(() => {});
    });
    const settled = vi.fn();
    result.catch(settled);
    const assertion = expect(result).rejects.toMatchObject({ path: '/x', timeoutMs: 1000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(result).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(RequestTimeoutError);
    await expect(result).rejects.toBe(signal?.reason);
  });

  it('the timeout wins over the rejection its own abort causes', async () => {
    const result = withRequestTimeout(
      '/x',
      1000,
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const assertion = expect(result).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('answers as the request does before the deadline, and leaves no timer behind', async () => {
    let signal: AbortSignal | undefined;
    const result = await withRequestTimeout('/x', 1000, async (s) => {
      signal = s;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    expect(signal?.aborted).toBe(false);
  });

  it('a request that fails before the deadline fails as it did, and leaves no timer behind', async () => {
    const failure = new HttpError('/x', 500);
    await expect(
      withRequestTimeout('/x', 1000, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a timeout reads as no answer: unconfirmed, a failed read, the could-not-reach sentence', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = new RequestTimeoutError('/x', 1000);
    expect(e).not.toBeInstanceOf(HttpError);
    expect(isConfirmedRefusal(e)).toBe(false);
    expect(toReadOutcome(e)).toBe('failed');
    expect(userFacingMessage(e, 'test')).toBe(HTTP_FAILED);
    expect(e.message).not.toContain('/x');
  });

  it('REQUEST_TIMEOUT_MS is 8 seconds', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(8_000);
  });
});

describe('httpFetch', () => {
  it('forwards a signal in its init to fetch, and has no deadline of its own', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = httpFetch('/stream', { signal: controller.signal });
    const settled = vi.fn();
    pending.then(settled, settled);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 10);
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
