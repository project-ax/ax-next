import { describe, expect, it } from 'vitest';
import { createMutex } from '../mutex.js';

/** A promise you settle by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createMutex', () => {
  it('runs one at a time, in arrival order', async () => {
    const lock = createMutex();
    const events: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, i) =>
      lock.run(async () => {
        events.push(`start ${i}`);
        await gate.promise;
        events.push(`end ${i}`);
        return i;
      }),
    );

    await settle();
    expect(events).toEqual(['start 0']);
    gates[2]!.resolve();
    gates[1]!.resolve();
    await settle();
    // 1 and 2 are ready to finish, but 0 still holds the lock.
    expect(events).toEqual(['start 0']);
    gates[0]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  it("hands back each call's own result or rejection", async () => {
    const lock = createMutex();
    const boom = new Error('boom');
    const failing = lock.run(async () => {
      throw boom;
    });
    const fine = lock.run(async () => 'ok');
    await expect(failing).rejects.toBe(boom);
    await expect(fine).resolves.toBe('ok');
  });

  it('a call that fails, even synchronously, does not hold up the next', async () => {
    const lock = createMutex();
    const throwsSync = (() => {
      throw new Error('sync');
    }) as unknown as () => Promise<never>;
    await expect(lock.run(throwsSync)).rejects.toThrow('sync');
    await expect(lock.run(async () => 'after')).resolves.toBe('after');
  });
});
