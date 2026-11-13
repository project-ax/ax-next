import { describe, expect, it } from 'vitest';
import { createKeyedQueue } from '../turn-queue.js';

/** A job the test finishes by hand, recording when it starts and ends. */
function gatedJob(log: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = async (): Promise<void> => {
    log.push(`start ${name}`);
    await gate;
    log.push(`end ${name}`);
  };
  return { job, release };
}

/** Let every promise callback that can run, run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createKeyedQueue', () => {
  it('same key runs in order', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    const a = gatedJob(log, 'a');
    const b = gatedJob(log, 'b');
    expect(q.enqueue('conv-1', a.job)).toBe('queued');
    expect(q.enqueue('conv-1', b.job)).toBe('queued');
    await settle();
    expect(log).toEqual(['start a']);
    a.release();
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    b.release();
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('different keys overlap', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    const a = gatedJob(log, 'a');
    const b = gatedJob(log, 'b');
    q.enqueue('conv-1', a.job);
    q.enqueue('conv-2', b.job);
    await settle();
    expect(log).toEqual(['start a', 'start b']);
    b.release();
    a.release();
    await settle();
    expect(log).toEqual(['start a', 'start b', 'end b', 'end a']);
  });

  it('the fourth for one key is full, and running counts toward the three', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((n) => gatedJob(log, n));
    expect(jobs.map((j) => q.enqueue('conv-1', j.job))).toEqual(['queued', 'queued', 'queued', 'full']);
    // Another conversation is not affected.
    expect(q.enqueue('conv-2', gatedJob(log, 'other').job)).toBe('queued');
    await settle();
    // Once the running one ends there is room for one more.
    jobs[0]!.release();
    await settle();
    expect(q.enqueue('conv-1', gatedJob(log, 'e').job)).toBe('queued');
    expect(q.enqueue('conv-1', gatedJob(log, 'f').job)).toBe('full');
    expect(log).not.toContain('start d');
  });

  it('close drops waiting jobs and refuses new ones; the running one finishes', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    const a = gatedJob(log, 'a');
    const b = gatedJob(log, 'b');
    q.enqueue('conv-1', a.job);
    q.enqueue('conv-1', b.job);
    await settle();
    q.close();
    expect(q.enqueue('conv-1', gatedJob(log, 'c').job)).toBe('closed');
    a.release();
    b.release();
    await settle();
    expect(log).toEqual(['start a', 'end a']);
  });

  it('a job that throws or rejects does not stop the next one', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    q.enqueue('conv-1', () => {
      throw new Error('sync throw');
    });
    q.enqueue('conv-1', async () => {
      throw new Error('async reject');
    });
    q.enqueue('conv-1', async () => {
      log.push('third ran');
    });
    await settle();
    expect(log).toEqual(['third ran']);
    // The key is free again: three more fit.
    const more = ['x', 'y', 'z'].map((n) => q.enqueue('conv-1', gatedJob(log, n).job));
    expect(more).toEqual(['queued', 'queued', 'queued']);
  });

  it('refuses a cap that is not a positive integer', () => {
    for (const maxPerKey of [0, -1, 1.5, Number.NaN]) {
      expect(() => createKeyedQueue({ maxPerKey }), String(maxPerKey)).toThrow(RangeError);
    }
  });
});
