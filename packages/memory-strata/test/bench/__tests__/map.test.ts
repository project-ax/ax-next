import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMap } from '../map.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus } from '../types.js';

function corpusOf(docs: ReturnType<typeof makeDoc>[]): BenchCorpus {
  const c: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
  for (const d of docs) c.memoryTree.set(d.path, d);
  return c;
}

describe('generateMap', () => {
  it('groups docs by category and emits one line per doc with sessionId + summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-'));
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-001', summary: 'discussed coffee preferences', body: '' }),
      makeDoc({ category: 'episodes', slug: 's-002', summary: 'discussed dog training', body: '' }),
      makeDoc({ category: 'knowledge', slug: 'kw-1', summary: 'caffeine biochem', body: '' }),
    ]);
    const map = await generateMap(corpus, { cacheDir: dir });
    expect(map).toContain('## episodes/');
    expect(map).toContain('## knowledge/');
    expect(map).toContain('- s-001: discussed coffee preferences');
    expect(map).toContain('- s-002: discussed dog training');
    expect(map).toContain('- kw-1: caffeine biochem');
  });

  it('truncates summaries to ~120 chars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-trunc-'));
    const long = 'x'.repeat(500);
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-1', summary: long, body: '' }),
    ]);
    const map = await generateMap(corpus, { cacheDir: dir });
    const line = map.split('\n').find((l) => l.startsWith('- s-1:'))!;
    expect(line.length).toBeLessThan(160);
  });

  it('caches the generated map keyed on (corpus.name + doc set hash)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-cache-'));
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 'x', summary: 'one', body: '' }),
    ]);
    const map1 = await generateMap(corpus, { cacheDir: dir });
    const map2 = await generateMap(corpus, { cacheDir: dir });
    expect(map1).toBe(map2);
  });

  it('filters to subsetPaths when provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-subset-'));
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 'a', summary: 'A', body: '' }),
      makeDoc({ category: 'episodes', slug: 'b', summary: 'B', body: '' }),
      makeDoc({ category: 'episodes', slug: 'c', summary: 'C', body: '' }),
    ]);
    const map = await generateMap(corpus, { cacheDir: dir, subsetPaths: ['episodes/a', 'episodes/c'] });
    expect(map).toContain('- a: A');
    expect(map).toContain('- c: C');
    expect(map).not.toContain('- b: B');
  });

  it('returns a map under the ~2k-token soft cap for 50 sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-budget-'));
    const docs = Array.from({ length: 50 }, (_, i) =>
      makeDoc({ category: 'episodes', slug: `s-${i.toString().padStart(3, '0')}`, summary: 'a short one-line summary about something memorable', body: '' }),
    );
    const map = await generateMap(corpusOf(docs), { cacheDir: dir });
    expect(map.length).toBeLessThan(8_000);
  });
});
