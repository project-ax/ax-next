import { describe, it, expect } from 'vitest';
import { withTimeout } from '../util/with-timeout.js';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, () => new Error('nope'));
    expect(result).toBe(42);
  });

  it('rejects with the factory error when the promise exceeds ms', async () => {
    const never = new Promise<number>(() => {});
    await expect(withTimeout(never, 20, () => new Error('timed out'))).rejects.toThrow('timed out');
  });

  it('treats a non-finite ms as "no timeout" (returns the promise directly)', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 40));
    // default would be far smaller, but Infinity disables the timer entirely
    await expect(withTimeout(slow, Number.POSITIVE_INFINITY, () => new Error('should not fire'))).resolves.toBe('ok');
  });

  it('does not surface an unhandled rejection when the loser rejects after timeout', async () => {
    const lateReject = new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error('late')), 10));
    await expect(withTimeout(lateReject, 5, () => new Error('timed out'))).rejects.toThrow('timed out');
    // give the late rejection time to fire; the .then handler must consume it
    await new Promise((r) => setTimeout(r, 20));
  });
});
