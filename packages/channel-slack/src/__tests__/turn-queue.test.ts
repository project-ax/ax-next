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
    expect(q.enqueue('conv-1', 'inst-a', a.job)).toBe('queued');
    expect(q.enqueue('conv-1', 'inst-a', b.job)).toBe('queued');
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
    q.enqueue('conv-1', 'inst-a', a.job);
    q.enqueue('conv-2', 'inst-b', b.job);
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
    expect(jobs.map((j) => q.enqueue('conv-1', 'inst-a', j.job))).toEqual(['queued', 'queued', 'queued', 'full']);
    // Another conversation is not affected.
    expect(q.enqueue('conv-2', 'inst-b', gatedJob(log, 'other').job)).toBe('queued');
    await settle();
    // Once the running one ends there is room for one more.
    jobs[0]!.release();
    await settle();
    expect(q.enqueue('conv-1', 'inst-a', gatedJob(log, 'e').job)).toBe('queued');
    expect(q.enqueue('conv-1', 'inst-a', gatedJob(log, 'f').job)).toBe('full');
    expect(log).not.toContain('start d');
  });

  it('close drops waiting jobs and refuses new ones; the running one finishes', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    const a = gatedJob(log, 'a');
    const b = gatedJob(log, 'b');
    q.enqueue('conv-1', 'inst-a', a.job);
    q.enqueue('conv-1', 'inst-a', b.job);
    await settle();
    // Says what it dropped, so the caller can log it: never silently.
    expect(q.close()).toEqual([{ group: 'inst-a', count: 1 }]);
    expect(q.enqueue('conv-1', 'inst-a', gatedJob(log, 'c').job)).toBe('closed');
    a.release();
    b.release();
    await settle();
    expect(log).toEqual(['start a', 'end a']);
    // Nothing is left to drop the second time.
    expect(q.close()).toEqual([]);
  });

  it("close counts each group's dropped jobs across its lanes, and leaves out a group with none waiting", async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    // inst-a: two conversations, each running one and holding waiting ones.
    for (const n of ['a1', 'a2', 'a3']) q.enqueue('conv-1', 'inst-a', gatedJob(log, n).job);
    for (const n of ['a4', 'a5']) q.enqueue('conv-2', 'inst-a', gatedJob(log, n).job);
    // inst-b: one running, none waiting.
    q.enqueue('conv-3', 'inst-b', gatedJob(log, 'b1').job);
    // inst-c: one running, one waiting.
    for (const n of ['c1', 'c2']) q.enqueue('conv-4', 'inst-c', gatedJob(log, n).job);
    await settle();
    expect(log).toEqual(['start a1', 'start a4', 'start b1', 'start c1']);
    const dropped = q.close();
    expect([...dropped].sort((x, y) => x.group.localeCompare(y.group))).toEqual([
      { group: 'inst-a', count: 3 },
      { group: 'inst-c', count: 1 },
    ]);
  });

  it('a job that throws or rejects does not stop the next one', async () => {
    const q = createKeyedQueue({ maxPerKey: 3 });
    const log: string[] = [];
    q.enqueue('conv-1', 'inst-a', () => {
      throw new Error('sync throw');
    });
    q.enqueue('conv-1', 'inst-a', async () => {
      throw new Error('async reject');
    });
    q.enqueue('conv-1', 'inst-a', async () => {
      log.push('third ran');
    });
    await settle();
    expect(log).toEqual(['third ran']);
    // The key is free again: three more fit.
    const more = ['x', 'y', 'z'].map((n) => q.enqueue('conv-1', 'inst-a', gatedJob(log, n).job));
    expect(more).toEqual(['queued', 'queued', 'queued']);
  });

  it('refuses a cap that is not a positive integer', () => {
    for (const maxPerKey of [0, -1, 1.5, Number.NaN]) {
      expect(() => createKeyedQueue({ maxPerKey }), String(maxPerKey)).toThrow(RangeError);
    }
  });
});
