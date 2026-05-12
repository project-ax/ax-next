import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigA } from '../configs/a-bm25.js';
import { createConfigB } from '../configs/b-rerank.js';
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
    const r = await driver.retrieve(
      { id: 'q', text: 'cortado', goldAnswer: 'x' },
      2,
      new AbortController().signal,
    );
    expect(r.retrievedDocs.length).toBe(2);
    expect(r.rerankTokens).toBe(50);
    rmSync(dir, { recursive: true, force: true });
    await driver.teardown();
  });
});
