import { describe, it, expect } from 'vitest';
import { allocate, spacedIndices, stratifiedSample, describeMix } from '../stratify.js';

/** A corpus shaped like LongMemEval-S: stored in question_type BLOCKS. */
function blockCorpus(): Array<{ id: number; type: string }> {
  const out: Array<{ id: number; type: string }> = [];
  const blocks: Array<[string, number]> = [
    ['single-session-user', 200],
    ['multi-session', 150],
    ['temporal-reasoning', 100],
    ['knowledge-update', 50],
  ];
  let id = 0;
  for (const [type, n] of blocks) for (let i = 0; i < n; i++) out.push({ id: id++, type });
  return out;
}

describe('allocate', () => {
  it('sums to the limit and stays proportional', () => {
    expect(allocate([200, 150, 100, 50], 100)).toEqual([40, 30, 20, 10]);
  });

  it('hands remainders to the largest fractional parts, ties to the lower index', () => {
    const got = allocate([1, 1, 1], 2);
    expect(got.reduce((a, b) => a + b, 0)).toBe(2);
    expect(got).toEqual([1, 1, 0]);
  });

  it('never allocates a stratum more than it holds', () => {
    const got = allocate([1, 99], 50);
    expect(got[0]).toBeLessThanOrEqual(1);
    expect(got.reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('returns everything when the limit covers the corpus', () => {
    expect(allocate([3, 4], 100)).toEqual([3, 4]);
  });
});

describe('spacedIndices', () => {
  it('spreads picks across the stratum instead of taking its head', () => {
    expect(spacedIndices(10, 5)).toEqual([0, 2, 4, 6, 8]);
  });
  it('degrades to everything when asked for more than it has', () => {
    expect(spacedIndices(3, 9)).toEqual([0, 1, 2]);
  });
});

describe('stratifiedSample', () => {
  it('draws every type in proportion — the bug this exists for', () => {
    // The old behaviour, `slice(0, 40)`, returns 40 single-session-user
    // questions and nothing else, because the corpus is stored in blocks.
    const corpus = blockCorpus();
    const prefix = corpus.slice(0, 40);
    expect(new Set(prefix.map((q) => q.type)).size).toBe(1);

    const sampled = stratifiedSample(corpus, 40, (q) => q.type);
    expect(sampled).toHaveLength(40);
    expect(describeMix(sampled, (q) => q.type)).toBe(
      'single-session-user=16 multi-session=12 temporal-reasoning=8 knowledge-update=4',
    );
  });

  it('reaches the late blocks a prefix can never see', () => {
    // knowledge-update starts at index 450 here; e2e-select.ts records the same
    // hazard in the real corpus, where it starts at position 434.
    const corpus = blockCorpus();
    const sampled = stratifiedSample(corpus, 20, (q) => q.type);
    expect(sampled.some((q) => q.type === 'knowledge-update')).toBe(true);
  });

  it('is deterministic — the same request yields the same questions', () => {
    const corpus = blockCorpus();
    const a = stratifiedSample(corpus, 37, (q) => q.type).map((q) => q.id);
    const b = stratifiedSample(corpus, 37, (q) => q.type).map((q) => q.id);
    expect(a).toEqual(b);
  });

  it('returns results in corpus order, not stratum order', () => {
    const ids = stratifiedSample(blockCorpus(), 40, (q) => q.type).map((q) => q.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('passes the whole corpus through when the limit covers it', () => {
    const corpus = blockCorpus();
    expect(stratifiedSample(corpus, 10_000, (q) => q.type)).toHaveLength(corpus.length);
  });

  it('degrades to an evenly spaced draw when nothing is labelled', () => {
    const corpus = Array.from({ length: 10 }, (_, i) => ({ id: i, type: undefined }));
    const got = stratifiedSample(corpus, 5, (q) => q.type);
    expect(got.map((q) => q.id)).toEqual([0, 2, 4, 6, 8]);
  });
});
