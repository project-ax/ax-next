import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigD } from '../configs/d-map.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus } from '../types.js';
import type { OrchestratorClient } from '../orchestrator.js';

function fixedClient(xml: string): OrchestratorClient {
  return {
    async complete() {
      return { text: xml, usage: { in: 50, out: 30 } };
    },
  };
}

describe('Config D (d-map)', () => {
  it('orchestrates against generated map and returns load-op docs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-d-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 's-001', summary: 'discussed hamster', body: 'hamster details' });
    const d2 = makeDoc({ category: 'episodes', slug: 's-002', summary: 'discussed cat', body: 'cat details' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const driver = createConfigD({
      tempDir: dir,
      orchestratorClient: fixedClient(`<load doc="episodes/s-001"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'about hamster', goldAnswer: 'h' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs.map((d) => d.path)).toEqual(['episodes/s-001']);
      expect(r.orchestratorTokens).toEqual({ in: 50, out: 30 });
      expect(r.followupNeeded).toBe(false);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records followupNeeded but does not run a fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-d-fu-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'x', summary: 'x', body: '' });
    corpus.memoryTree.set(d1.path, d1);
    const driver = createConfigD({
      tempDir: dir,
      orchestratorClient: fixedClient(`<followup needed="true"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'x', goldAnswer: 'x' },
        5,
        new AbortController().signal,
      );
      expect(r.followupNeeded).toBe(true);
      expect(r.retrievedDocs.length).toBe(0);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves fts ops against the BM25 plugin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-d-fts-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'coffee', summary: 'coffee', body: 'cortado is espresso with milk' });
    corpus.memoryTree.set(d1.path, d1);
    const driver = createConfigD({
      tempDir: dir,
      orchestratorClient: fixedClient(`<fts query="cortado"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'what is a cortado', goldAnswer: 'milk + espresso' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs[0]!.path).toBe('episodes/coffee');
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
