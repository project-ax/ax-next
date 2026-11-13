import { describe, expect, it } from 'vitest';
import { LifetimeClosedError, createLifetime } from '../lifetime.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createLifetime', () => {
  it('admits work until stopAdmission, then refuses new outside work', async () => {
    const lifetime = createLifetime();
    expect(await lifetime.admit(async () => 'ran')).toBe('ran');
    lifetime.stopAdmission();
    let ran = false;
    await expect(
      lifetime.admit(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(LifetimeClosedError);
    expect(ran).toBe(false);
  });

  it('still tracks follow-on work after stopAdmission, and drain waits for it', async () => {
    const lifetime = createLifetime();
    const gate = deferred();
    const order: string[] = [];
    const admitted = lifetime.admit(async () => {
      order.push('admitted');
      // Work an admitted request starts on its way out, like an event dispatch.
      void lifetime.track(async () => {
        await gate.promise;
        order.push('follow-on');
      });
    });
    lifetime.stopAdmission();
    await admitted;

    const drained = lifetime.drain().then(() => order.push('drained'));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['admitted']);
    gate.resolve();
    await drained;
    expect(order).toEqual(['admitted', 'follow-on', 'drained']);
  });

  it('refuses everything once drained', async () => {
    const lifetime = createLifetime();
    await lifetime.drain();
    await expect(lifetime.track(async () => undefined)).rejects.toBeInstanceOf(
      LifetimeClosedError,
    );
    await expect(lifetime.admit(async () => undefined)).rejects.toBeInstanceOf(
      LifetimeClosedError,
    );
  });

  it('a failed effect does not stop drain', async () => {
    const lifetime = createLifetime();
    const failing = lifetime.track(async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(lifetime.drain()).resolves.toBeUndefined();
  });
});
