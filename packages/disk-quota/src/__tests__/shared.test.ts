import { describe, it, expect } from 'vitest';
import { createLimiter } from '../shared.js';

// createLimiter bounds how many agent-files walks run at once (TASK-993). No
// database here: it is plain promise plumbing.
describe('createLimiter', () => {
  function gated() {
    const opens: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (id: number, fail = false) => async () => {
      started.push(id);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => opens.push(r));
      inFlight--;
      if (fail) throw new Error(`task ${id} failed`);
      return id;
    };
    return {
      task,
      started,
      peak: () => peak,
      openNext: () => opens.shift()?.(),
      pending: () => opens.length,
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('runs at most `max` at once, starts the rest in arrival order, and passes results through', async () => {
    const limiter = createLimiter(2);
    const g = gated();
    const results = [1, 2, 3, 4, 5].map((id) => limiter.run(g.task(id)));
    await tick();
    expect(g.started).toEqual([1, 2]);
    for (let i = 0; i < 5; i++) {
      g.openNext();
      await tick();
    }
    expect(await Promise.all(results)).toEqual([1, 2, 3, 4, 5]);
    expect(g.started).toEqual([1, 2, 3, 4, 5]);
    expect(g.peak()).toBe(2);
  });

  it('a task that throws frees its slot and its caller sees the rejection', async () => {
    const limiter = createLimiter(1);
    const g = gated();
    const first = limiter.run(g.task(1, true));
    const second = limiter.run(g.task(2));
    await tick();
    expect(g.started).toEqual([1]);
    g.openNext();
    await expect(first).rejects.toThrow('task 1 failed');
    await tick();
    expect(g.started).toEqual([1, 2]);
    g.openNext();
    await expect(second).resolves.toBe(2);
  });

  it('a synchronous throw also frees the slot', async () => {
    const limiter = createLimiter(1);
    await expect(
      limiter.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('treats a max below one as one', async () => {
    const limiter = createLimiter(0);
    const g = gated();
    const a = limiter.run(g.task(1));
    const b = limiter.run(g.task(2));
    await tick();
    expect(g.started).toEqual([1]);
    g.openNext();
    await tick();
    g.openNext();
    expect(await Promise.all([a, b])).toEqual([1, 2]);
  });
});
