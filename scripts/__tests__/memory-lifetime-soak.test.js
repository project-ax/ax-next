import { describe, expect, it } from 'vitest';
import {
  buildVocabulary,
  diskAllows,
  goldIds,
  hitRate,
  linearFit,
  mulberry32,
  quantile,
  randomUnitVector,
  rankOfFirstGold,
  sampleWord,
  seededShuffle,
  summarize,
  syntheticStatement,
} from '../memory-lifetime-soak-lib.mjs';

const ACTIVE = '9999-12-31T23:59:59.999Z';

describe('seeded generation', () => {
  it('is reproducible for a seed and differs across seeds', () => {
    const a = mulberry32(520);
    const b = mulberry32(520);
    const c = mulberry32(521);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, c)).not.toEqual(seqA);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });

  it('makes 384-d unit vectors whose direction is not axis-biased', () => {
    const rand = mulberry32(1);
    const v = randomUnitVector(rand);
    expect(v).toHaveLength(384);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    // Uniform-on-the-sphere components have mean ~0; uniform-[0,1) ones would all be positive.
    expect(v.some(x => x < 0)).toBe(true);
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
  });

  it('shuffles a copy, keeping every item', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = seededShuffle(items, mulberry32(3));
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort()).toEqual(items);
    expect(out).not.toEqual(items);
  });

  it('samples words in proportion to their frequency', () => {
    const vocab = buildVocabulary(['a a a a a a a a a b']);
    const rand = mulberry32(9);
    const draws = Array.from({ length: 2000 }, () => sampleWord(vocab, rand));
    const share = draws.filter(w => w === 'a').length / draws.length;
    expect(share).toBeGreaterThan(0.85);
    expect(share).toBeLessThan(0.95);
  });

  it('fills a synthetic value to the template value length, from the vocabulary', () => {
    const templates = [{ about: 'assistant', relation: 'recommended_book', value: 'x'.repeat(200) }];
    const vocab = buildVocabulary(['alpha beta gamma delta']);
    const row = syntheticStatement(templates, vocab, mulberry32(4));
    expect(row.about).toBe('assistant');
    expect(row.relation).toBe('recommended_book');
    expect(row.value.length).toBeGreaterThanOrEqual(200);
    expect(row.value.length).toBeLessThan(200 + 6);
    for (const word of row.value.split(' ')) expect(['alpha', 'beta', 'gamma', 'delta']).toContain(word);
  });
});

describe('gold and rank', () => {
  const rows = [
    { id: 'g1', conversation_id: 's1', valid_end: ACTIVE },
    { id: 'closed', conversation_id: 's1', valid_end: '2024-01-01T00:00:00.000Z' },
    { id: 'other', conversation_id: 's9', valid_end: ACTIVE },
  ];

  it('takes only ACTIVE rows from evidence sessions', () => {
    expect([...goldIds(rows, ['s1'], ACTIVE)]).toEqual(['g1']);
    expect(goldIds(rows, ['nope'], ACTIVE).size).toBe(0);
  });

  it('ranks the first gold id, 1-based, or null when absent', () => {
    const gold = new Set(['g1', 'g2']);
    expect(rankOfFirstGold(['x', 'g2', 'g1'], gold)).toBe(2);
    expect(rankOfFirstGold(['g1'], gold)).toBe(1);
    expect(rankOfFirstGold(['x', 'y'], gold)).toBeNull();
  });

  it('counts an absent gold as a miss for hit@k', () => {
    expect(hitRate([1, 15, 16, null], 15)).toBe(0.5);
    expect(hitRate([], 15)).toBeNull();
  });
});

describe('statistics', () => {
  it('uses nearest-rank quantiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(values, 0.5)).toBe(50);
    expect(quantile(values, 0.95)).toBe(95);
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('summarizes finite values only', () => {
    expect(summarize([1, 2, 3, Number.NaN])).toEqual({ n: 3, mean: 2, p50: 2, p95: 3, max: 3 });
    expect(summarize([]).n).toBe(0);
  });

  it('fits a line exactly when the points are collinear', () => {
    const fit = linearFit([10_000, 100_000, 500_000], [3, 12, 52]);
    expect(fit.slope * 100_000).toBeCloseTo(10, 6);
    expect(fit.intercept).toBeCloseTo(2, 6);
    expect(fit.r2).toBeCloseTo(1, 9);
    expect(() => linearFit([1], [1])).toThrow();
    expect(() => linearFit([1, 1], [1, 2])).toThrow();
  });
});

describe('disk guard', () => {
  const GiB = 1024 ** 3;
  it('refuses a step that would eat into the reserve', () => {
    expect(diskAllows({ freeBytes: 2 * GiB, bytesPerRow: 3000, addRows: 100_000, reserveBytes: GiB }).ok).toBe(true);
    // 250k rows × 3000 B × 1.3 ≈ 0.91 GiB; 1.8 GiB free leaves < 1 GiB.
    expect(diskAllows({ freeBytes: 1.8 * GiB, bytesPerRow: 3000, addRows: 250_000, reserveBytes: GiB }).ok).toBe(false);
  });

  it('fails closed on nonsense input', () => {
    expect(() => diskAllows({ freeBytes: Number.NaN, bytesPerRow: 1, addRows: 1, reserveBytes: 0 })).toThrow();
    expect(() => diskAllows({ freeBytes: 1, bytesPerRow: 0, addRows: 1, reserveBytes: 0 })).toThrow();
  });
});
