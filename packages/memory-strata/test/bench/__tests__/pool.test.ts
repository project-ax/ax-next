import { describe, it, expect } from 'vitest';
import { runPool } from '../pool.js';

describe('runPool', () => {
  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
      { concurrency: 4 },
    );
    expect(peak).toBe(4);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], async (n) => { seen.push(n); }, { concurrency: 3 });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops dispatching when shouldStop flips, without killing work in flight', async () => {
    // The cost cap uses this. In-flight questions must still finish: aborting
    // them strands a half-ingested workspace and spend that was already paid.
    const started: number[] = [];
    const finished: number[] = [];
    let stop = false;
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 5));
        if (n >= 3) stop = true;
        finished.push(n);
      },
      { concurrency: 2, shouldStop: () => stop },
    );
    expect(started.length).toBeLessThan(20);
    expect(finished.sort((a, b) => a - b)).toEqual(started.sort((a, b) => a - b));
  });

  it('keeps going when one task throws — one bad item must not void its siblings', async () => {
    const done: number[] = [];
    await runPool(
      [1, 2, 3, 4],
      async (n) => {
        try {
          if (n === 2) throw new Error('boom');
          done.push(n);
        } catch { /* the caller owns error handling, exactly as the e2e loop does */ }
      },
      { concurrency: 2 },
    );
    expect(done.sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('treats concurrency < 1 as 1 rather than dispatching nothing', async () => {
    const seen: number[] = [];
    await runPool([1, 2], async (n) => { seen.push(n); }, { concurrency: 0 });
    expect(seen).toEqual([1, 2]);
  });

  it('handles an empty item list', async () => {
    await expect(runPool([], async () => {}, { concurrency: 4 })).resolves.toBeUndefined();
  });
});
