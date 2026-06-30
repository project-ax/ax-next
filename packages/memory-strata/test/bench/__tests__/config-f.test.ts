import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigF } from '../configs/f-fair-rerank.js';
import type { RerankClient } from '../configs/b-rerank.js';
import type { BenchCorpus } from '../types.js';
import { makeDoc } from '../corpora/shared.js';

function corpusWith(docs: ReturnType<typeof makeDoc>[]): BenchCorpus {
  const c: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
  for (const d of docs) c.memoryTree.set(d.path, d);
  return c;
}

describe('Config F (fair reranker: full bodies + query expansion + wide pool)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bench-cfg-f-')); });

  it('feeds the reranker FULL bodies (no 2000-char truncation)', async () => {
    const big = 'cortado '.repeat(2000); // ~16000 chars, far past the old 2000 cap
    const corpus = corpusWith([
      makeDoc({ category: 'knowledge', slug: 'big', summary: 'huge', body: big }),
    ]);
    const captured: Array<Array<{ docId: string; text: string }>> = [];
    const rerankClient: RerankClient = {
      async rerank(_q, docs) {
        captured.push(docs);
        return { reranked: docs.map((d, i) => ({ docId: d.docId, score: 1 - i * 0.1 })), tokens: 7 };
      },
    };
    const driver = createConfigF({ tempDir: dir, rerankClient });
    await driver.build(corpus);
    try {
      await driver.retrieve({ id: 'q', text: 'cortado', goldAnswer: 'x' }, 5, new AbortController().signal);
      expect(captured.length).toBe(1);
      // Full body must reach the reranker untruncated.
      expect(captured[0]![0]!.text.length).toBeGreaterThan(2000);
      expect(captured[0]![0]!.text).toBe(big);
    } finally {
      await driver.teardown();
    }
  });

  it('reorders docs by rerank score and reports rerankTokens + rerankMs', async () => {
    const corpus = corpusWith([
      makeDoc({ category: 'knowledge', slug: 'd1', summary: 'first', body: 'cortado milk espresso here' }),
      makeDoc({ category: 'knowledge', slug: 'd2', summary: 'second', body: 'cortado is a great drink' }),
    ]);
    // Reranker promotes d2 above d1 regardless of BM25 order.
    const rerankClient: RerankClient = {
      async rerank(_q, docs) {
        const scoreFor = (id: string) => (id === 'knowledge/d2' ? 0.9 : 0.1);
        return { reranked: docs.map((d) => ({ docId: d.docId, score: scoreFor(d.docId) })), tokens: 12 };
      },
    };
    const driver = createConfigF({ tempDir: dir, rerankClient });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve({ id: 'q', text: 'cortado', goldAnswer: 'x' }, 2, new AbortController().signal);
      expect(r.retrievedDocs[0]!.path).toBe('knowledge/d2');
      expect(r.rerankTokens).toBe(12);
      expect(typeof r.rerankMs).toBe('number');
      expect(r.rerankMs).toBeGreaterThanOrEqual(0);
    } finally {
      await driver.teardown();
    }
  });

  it('uses query expansion for the second-pass retrieval (expanded query feeds the rerank docs)', async () => {
    // d1 only matches the RAW query; d2 only matches a PRF term harvested from d1's body.
    // A wide first pass surfaces d1; expansion then pulls "patagonia" into the query so the
    // second pass also surfaces d2. We assert the reranker sees BOTH docs.
    const corpus = corpusWith([
      makeDoc({ category: 'episodes', slug: 'd1', summary: 's1', body: 'I went hiking near Patagonia last spring' }),
      makeDoc({ category: 'episodes', slug: 'd2', summary: 's2', body: 'Patagonia is in southern Argentina' }),
      makeDoc({ category: 'episodes', slug: 'd3', summary: 's3', body: 'totally unrelated banana content' }),
    ]);
    const seenQueries: string[] = [];
    const rerankClient: RerankClient = {
      async rerank(_q, docs) {
        return { reranked: docs.map((d, i) => ({ docId: d.docId, score: 1 - i * 0.1 })), tokens: 1 };
      },
    };
    const driver = createConfigF({
      tempDir: dir,
      rerankClient,
      onSecondPassQuery: (q) => seenQueries.push(q),
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve({ id: 'q', text: 'where did I go hiking', goldAnswer: 'x' }, 5, new AbortController().signal);
      // The second-pass query must be expanded beyond the raw query.
      expect(seenQueries.length).toBe(1);
      expect(seenQueries[0]!.startsWith('where did I go hiking')).toBe(true);
      expect(seenQueries[0]!.toLowerCase()).toContain('patagonia');
      // Both Patagonia docs should be retrievable & reranked.
      const paths = r.retrievedDocs.map((d) => d.path);
      expect(paths).toContain('episodes/d1');
      expect(paths).toContain('episodes/d2');
    } finally {
      await driver.teardown();
    }
  });

  it('requests a WIDE candidate pool from BM25 (default 50), not topK*3', async () => {
    const docs = Array.from({ length: 60 }, (_, i) =>
      makeDoc({ category: 'episodes', slug: `s${i}`, summary: `sum ${i}`, body: `apple content number ${i} apple` }),
    );
    const corpus = corpusWith(docs);
    let candidateCount = 0;
    const rerankClient: RerankClient = {
      async rerank(_q, d) {
        candidateCount = d.length;
        return { reranked: d.map((x, i) => ({ docId: x.docId, score: 1 - i * 0.001 })), tokens: 1 };
      },
    };
    const driver = createConfigF({ tempDir: dir, rerankClient });
    await driver.build(corpus);
    try {
      await driver.retrieve({ id: 'q', text: 'apple', goldAnswer: 'x' }, 5, new AbortController().signal);
      // Default wide pool is 50 — far more than topK*3 = 15.
      expect(candidateCount).toBeGreaterThan(15);
      expect(candidateCount).toBeLessThanOrEqual(50);
    } finally {
      await driver.teardown();
    }
  });
});
