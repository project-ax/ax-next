import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigA } from '../configs/a-bm25.js';
import { createConfigB } from '../configs/b-rerank.js';
import { createConfigC, rrfFuse } from '../configs/c-rrf.js';
import type { BenchCorpus } from '../types.js';
import { makeDoc } from '../corpora/shared.js';

describe('Config A (BM25)', () => {
  let dir: string;
  let corpus: BenchCorpus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-cfg-a-'));
    corpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const docA = makeDoc({ category: 'knowledge', slug: 'cortado', summary: 'about cortados', body: 'A cortado is espresso with milk.' });
    const docB = makeDoc({ category: 'knowledge', slug: 'latte', summary: 'about lattes', body: 'A latte is mostly milk.' });
    corpus.memoryTree.set(docA.path, docA);
    corpus.memoryTree.set(docB.path, docB);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('retrieves cortado-relevant doc for a cortado query', async () => {
    const driver = createConfigA({ tempDir: dir });
    await driver.build(corpus);
    const result = await driver.retrieve(
      { id: 'q', text: 'What is a cortado?', goldAnswer: 'espresso + milk' },
      5,
      new AbortController().signal,
    );
    expect(result.retrievedDocs[0]!.path).toBe('knowledge/cortado');
    await driver.teardown();
  });
});

describe('Config B (BM25 + rerank)', () => {
  it('reorders Config A results via stubbed reranker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-b-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'knowledge', slug: 'd1', summary: 'first', body: 'cortado milk espresso' });
    const d2 = makeDoc({ category: 'knowledge', slug: 'd2', summary: 'second', body: 'cortado is great' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const driver = createConfigB({
      tempDir: dir,
      rerankClient: {
        async rerank(_query, docs) {
          return { reranked: [...docs].reverse().map((d, i) => ({ docId: d.docId, score: 1 - i * 0.1 })), tokens: 50 };
        },
      },
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'cortado', goldAnswer: 'x' },
        2,
        new AbortController().signal,
      );
      expect(r.retrievedDocs.length).toBe(2);
      expect(r.rerankTokens).toBe(50);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rrfFuse', () => {
  it('combines two ranked lists with reciprocal rank fusion', () => {
    const bm = [{ path: 'a', score: 1 }, { path: 'b', score: 0.5 }];
    const vec = [{ path: 'b', score: 0.9 }, { path: 'c', score: 0.8 }];
    const fused = rrfFuse(bm, vec, { k: 60, topK: 3 });
    expect(fused[0]!.path).toBe('b');  // appears in both lists → top
  });
});

describe('Config C (BM25 + dense + RRF)', () => {
  it('returns a fused list and accounts embedding tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-c-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'knowledge', slug: 'd1', summary: 'first', body: 'apple banana' });
    const d2 = makeDoc({ category: 'knowledge', slug: 'd2', summary: 'second', body: 'orange grape' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const driver = createConfigC({
      tempDir: dir,
      embedClient: {
        async embed(texts, _inputType) {
          return { vectors: texts.map((t) => [t.length, 0, 0, 0]), tokens: texts.length * 10 };
        },
      },
      embeddingDim: 4,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'apple', goldAnswer: 'fruit' },
        2,
        new AbortController().signal,
      );
      expect(r.retrievedDocs.length).toBeGreaterThan(0);
      expect(r.embeddingTokens).toBeGreaterThan(0);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
