import { describe, it, expect } from 'vitest';
import { parseOrchestratorXml, runOrchestrator, runOps } from '../orchestrator.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus } from '../types.js';
import type { OrchestratorClient } from '../orchestrator.js';

describe('parseOrchestratorXml', () => {
  it('extracts load ops with doc + optional section', () => {
    const xml = `<retrieve><load doc="episodes/s-1"/><load doc="episodes/s-2" section="## response"/></retrieve>`;
    const { ops, followupNeeded } = parseOrchestratorXml(xml);
    expect(followupNeeded).toBe(false);
    expect(ops).toEqual([
      { kind: 'load', doc: 'episodes/s-1' },
      { kind: 'load', doc: 'episodes/s-2', section: '## response' },
    ]);
  });

  it('extracts fts ops and trims whitespace', () => {
    const { ops } = parseOrchestratorXml(`<fts query="  refund window  "/>`);
    expect(ops).toEqual([{ kind: 'fts', query: 'refund window' }]);
  });

  it('detects followup=true marker', () => {
    const { followupNeeded } = parseOrchestratorXml(`<followup needed="true"/>`);
    expect(followupNeeded).toBe(true);
  });

  it('strips markdown code fences if the model wraps output', () => {
    const xml = '```xml\n<load doc="x"/>\n```';
    const { ops } = parseOrchestratorXml(xml);
    expect(ops).toEqual([{ kind: 'load', doc: 'x' }]);
  });

  it('returns empty ops + followup=false on unparseable input', () => {
    const r = parseOrchestratorXml('this is not xml');
    expect(r.ops).toEqual([]);
    expect(r.followupNeeded).toBe(false);
  });

  it('handles single-quoted attributes', () => {
    const { ops } = parseOrchestratorXml(`<load doc='episodes/s-1'/>`);
    expect(ops).toEqual([{ kind: 'load', doc: 'episodes/s-1' }]);
  });

  it('decodes XML entities in attribute values', () => {
    const { ops } = parseOrchestratorXml(`<fts query="cats &amp; dogs"/>`);
    expect(ops).toEqual([{ kind: 'fts', query: 'cats & dogs' }]);
  });
});

describe('runOrchestrator', () => {
  it('sends map + query to the client and parses the response', async () => {
    let capturedUser: string | null = null;
    const stub: OrchestratorClient = {
      async complete({ user }) {
        capturedUser = user;
        return { text: `<load doc="episodes/s-1"/>`, usage: { in: 10, out: 5 } };
      },
    };
    const r = await runOrchestrator(stub, 'MAP HERE', 'What did I name my hamster?');
    expect(capturedUser).toContain('MAP HERE');
    expect(capturedUser).toContain('What did I name my hamster?');
    expect(r.ops).toEqual([{ kind: 'load', doc: 'episodes/s-1' }]);
    expect(r.usage).toEqual({ in: 10, out: 5 });
  });
});

describe('runOps', () => {
  it('resolves load ops against the corpus and FTS ops against the search fn', async () => {
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 's-1', summary: 'hamster Luna', body: '' });
    const d2 = makeDoc({ category: 'episodes', slug: 's-2', summary: 'cat training', body: '' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const ftsCalls: string[] = [];
    const ftsSearch = async (query: string, _topK: number) => {
      ftsCalls.push(query);
      return [{ path: 'episodes/s-2', score: 0.5, summary: 'cat training' }];
    };

    const docs = await runOps(
      { ops: [{ kind: 'load', doc: 'episodes/s-1' }, { kind: 'fts', query: 'cat' }], followupNeeded: false },
      { corpus, ftsSearch, topK: 5 },
    );
    expect(docs.map((d) => d.path)).toEqual(['episodes/s-1', 'episodes/s-2']);
    expect(ftsCalls).toEqual(['cat']);

    const docs2 = await runOps(
      { ops: [{ kind: 'load', doc: 'episodes/s-2' }, { kind: 'fts', query: 'cat' }], followupNeeded: false },
      { corpus, ftsSearch, topK: 5 },
    );
    expect(docs2.map((d) => d.path)).toEqual(['episodes/s-2']);
  });

  it('drops load ops that reference unknown docs', async () => {
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'x', summary: 'x', body: '' });
    corpus.memoryTree.set(d1.path, d1);
    const docs = await runOps(
      { ops: [{ kind: 'load', doc: 'episodes/missing' }, { kind: 'load', doc: 'episodes/x' }], followupNeeded: false },
      { corpus, ftsSearch: async () => [], topK: 5 },
    );
    expect(docs.map((d) => d.path)).toEqual(['episodes/x']);
  });

  it('caps results at topK', async () => {
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    for (let i = 0; i < 10; i++) {
      const d = makeDoc({ category: 'episodes', slug: `s-${i}`, summary: `s${i}`, body: '' });
      corpus.memoryTree.set(d.path, d);
    }
    const docs = await runOps(
      { ops: Array.from({ length: 10 }, (_, i) => ({ kind: 'load' as const, doc: `episodes/s-${i}` })), followupNeeded: false },
      { corpus, ftsSearch: async () => [], topK: 3 },
    );
    expect(docs.length).toBe(3);
  });
});
