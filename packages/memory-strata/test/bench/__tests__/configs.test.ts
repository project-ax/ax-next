import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigA } from '../configs/a-bm25.js';
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
