import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  rewriteMapSummaries,
  loadMapRewriteCache,
  writeMapRewriteCache,
  hashDocBody,
  cacheToOverrideMap,
  cleanSummary,
  withConcurrency,
  type MapRewriteCache,
} from '../map-rewrite.js';
import { makeDoc } from '../corpora/shared.js';
import type { OrchestratorClient } from '../orchestrator.js';
import type { BenchCorpus } from '../types.js';

function corpusOf(docs: ReturnType<typeof makeDoc>[]): BenchCorpus {
  const c: BenchCorpus = { name: 'longmemeval-s', memoryTree: new Map(), questions: [] };
  for (const d of docs) c.memoryTree.set(d.path, d);
  return c;
}

function makeStubClient(
  respond: (user: string) => string,
): { client: OrchestratorClient; calls: { count: () => number; users: () => string[] } } {
  const seen: string[] = [];
  const client: OrchestratorClient = {
    async complete({ user }) {
      seen.push(user);
      return { text: respond(user), usage: { in: 10, out: 5 } };
    },
  };
  return { client, calls: { count: () => seen.length, users: () => seen } };
}

describe('rewriteMapSummaries', () => {
  it('rewrites all docs and writes cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-all-'));
    const cachePath = join(dir, 'map-rewrites.json');
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-1', summary: 'orig', body: 'body-1' }),
      makeDoc({ category: 'episodes', slug: 's-2', summary: 'orig', body: 'body-2' }),
    ]);
    const { client, calls } = makeStubClient((u) => `REWRITE: ${u.slice(0, 40)}`);

    const result = await rewriteMapSummaries({ corpus, grokClient: client, cachePath });

    expect(calls.count()).toBe(2);
    expect(result.size).toBe(2);
    expect(result.get('episodes/s-1')).toMatch(/^REWRITE:/);
    expect(result.get('episodes/s-2')).toMatch(/^REWRITE:/);

    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as MapRewriteCache;
    expect(cache['episodes/s-1']?.hash).toBe(hashDocBody('body-1'));
    expect(cache['episodes/s-2']?.hash).toBe(hashDocBody('body-2'));
    expect(cache['episodes/s-1']?.summary).toMatch(/^REWRITE:/);
  });

  it('skips docs already cached with matching content hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-skip-'));
    const cachePath = join(dir, 'map-rewrites.json');
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-1', summary: 'orig', body: 'body-1' }),
      makeDoc({ category: 'episodes', slug: 's-2', summary: 'orig', body: 'body-2' }),
    ]);
    // Pre-populate cache: s-1 with matching hash, s-2 missing.
    const seeded: MapRewriteCache = {
      'episodes/s-1': { hash: hashDocBody('body-1'), summary: 'cached-s-1' },
    };
    writeMapRewriteCache(cachePath, seeded);

    const { client, calls } = makeStubClient(() => 'FRESH');
    const result = await rewriteMapSummaries({ corpus, grokClient: client, cachePath });

    expect(calls.count()).toBe(1); // only s-2 hit the model
    expect(result.get('episodes/s-1')).toBe('cached-s-1');
    expect(result.get('episodes/s-2')).toBe('FRESH');
  });

  it('re-rewrites docs whose body has changed (hash mismatch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-mismatch-'));
    const cachePath = join(dir, 'map-rewrites.json');
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-1', summary: 'orig', body: 'new-body' }),
    ]);
    const stale: MapRewriteCache = {
      'episodes/s-1': { hash: 'stalehash00000000', summary: 'stale-summary' },
    };
    writeMapRewriteCache(cachePath, stale);

    const { client, calls } = makeStubClient(() => 'FRESH-REWRITE');
    const result = await rewriteMapSummaries({ corpus, grokClient: client, cachePath });

    expect(calls.count()).toBe(1);
    expect(result.get('episodes/s-1')).toBe('FRESH-REWRITE');
    const onDisk = JSON.parse(readFileSync(cachePath, 'utf8')) as MapRewriteCache;
    expect(onDisk['episodes/s-1']?.hash).toBe(hashDocBody('new-body'));
    expect(onDisk['episodes/s-1']?.summary).toBe('FRESH-REWRITE');
  });

  it('honors concurrency limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-concurrency-'));
    const cachePath = join(dir, 'map-rewrites.json');
    const docs = Array.from({ length: 20 }, (_, i) =>
      makeDoc({ category: 'episodes', slug: `s-${i}`, summary: 'orig', body: `body-${i}` }),
    );
    const corpus = corpusOf(docs);

    let inFlight = 0;
    let peak = 0;
    const client: OrchestratorClient = {
      async complete() {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        // Yield so all workers actually pile up before any finishes.
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { text: 'rewritten', usage: { in: 1, out: 1 } };
      },
    };

    await rewriteMapSummaries({ corpus, grokClient: client, cachePath, concurrency: 4 });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // sanity: workers did run in parallel
  });

  it('reports progress for cached entries up front and every completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-progress-'));
    const cachePath = join(dir, 'map-rewrites.json');
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-1', summary: 'orig', body: 'b1' }),
      makeDoc({ category: 'episodes', slug: 's-2', summary: 'orig', body: 'b2' }),
    ]);
    writeMapRewriteCache(cachePath, {
      'episodes/s-1': { hash: hashDocBody('b1'), summary: 'cached' },
    });
    const onProgress = vi.fn();
    const { client } = makeStubClient(() => 'FRESH');
    await rewriteMapSummaries({ corpus, grokClient: client, cachePath, onProgress });
    // First call must reflect the pre-cached entry (done=1, total=2).
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('persists cache mid-run so partial work survives a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-resume-'));
    const cachePath = join(dir, 'map-rewrites.json');
    // 60 docs > FLUSH_EVERY (50) so we get an intermediate flush.
    const docs = Array.from({ length: 60 }, (_, i) =>
      makeDoc({ category: 'episodes', slug: `s-${i}`, summary: 'orig', body: `body-${i}` }),
    );
    const corpus = corpusOf(docs);
    const { client } = makeStubClient(() => 'OK');
    await rewriteMapSummaries({ corpus, grokClient: client, cachePath, concurrency: 1 });
    expect(existsSync(cachePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(cachePath, 'utf8')) as MapRewriteCache;
    expect(Object.keys(onDisk).length).toBe(60);
  });
});

describe('cleanSummary', () => {
  it('trims whitespace and code fences', () => {
    expect(cleanSummary('```\nfoo\n```')).toBe('foo');
  });

  it('strips leading Summary: prefix', () => {
    expect(cleanSummary('Summary: hello')).toBe('hello');
    expect(cleanSummary('summary - hi')).toBe('hi');
  });

  it('keeps only the first non-empty line', () => {
    expect(cleanSummary('first line\nsecond line')).toBe('first line');
  });

  it('truncates over-long output to 120 chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = cleanSummary(long);
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('loadMapRewriteCache', () => {
  it('returns {} when file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-missing-'));
    expect(loadMapRewriteCache(join(dir, 'nope.json'))).toEqual({});
  });

  it('returns {} when file is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-malformed-'));
    const p = join(dir, 'cache.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'not-json{');
    expect(loadMapRewriteCache(p)).toEqual({});
  });

  it('drops entries that are missing hash or summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rewrite-partial-'));
    const p = join(dir, 'cache.json');
    writeFileSync(
      p,
      JSON.stringify({
        good: { hash: 'h', summary: 's' },
        badShape: { summary: 's' },
        notObj: 'oops',
      }),
    );
    const out = loadMapRewriteCache(p);
    expect(out).toEqual({ good: { hash: 'h', summary: 's' } });
  });
});

describe('cacheToOverrideMap', () => {
  it('flattens to a Map<path, summary>', () => {
    const cache: MapRewriteCache = {
      a: { hash: 'h1', summary: 'sa' },
      b: { hash: 'h2', summary: 'sb' },
    };
    const m = cacheToOverrideMap(cache);
    expect(m.size).toBe(2);
    expect(m.get('a')).toBe('sa');
    expect(m.get('b')).toBe('sb');
  });
});

describe('withConcurrency', () => {
  it('preserves item order in results', async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await withConcurrency(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, 6 - n));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('handles empty input', async () => {
    const out = await withConcurrency([], 4, async (x) => x);
    expect(out).toEqual([]);
  });
});
