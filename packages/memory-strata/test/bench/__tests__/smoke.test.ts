import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigA } from '../configs/a-bm25.js';
import { createConfigB } from '../configs/b-rerank.js';
import { createConfigC } from '../configs/c-rrf.js';
import { runAgent } from '../agent.js';
import { judgeAnswer } from '../judge.js';
import type { BenchCorpus } from '../types.js';
import { makeDoc } from '../corpora/shared.js';

function makeStubCorpus(name: BenchCorpus['name']): BenchCorpus {
  const c: BenchCorpus = { name, memoryTree: new Map(), questions: [] };
  for (let i = 0; i < 10; i++) {
    const d = makeDoc({
      category: 'knowledge',
      slug: `doc-${i}`,
      summary: `Summary of doc ${i}`,
      body: `# Doc ${i}\n## Section\nThis doc covers topic-${i} extensively.`,
    });
    c.memoryTree.set(d.path, d);
    c.questions.push({
      id: `q-${i}`,
      text: `What does topic-${i} cover?`,
      goldAnswer: `topic-${i}`,
      goldDocIds: [d.path],
    });
  }
  return c;
}

describe('Smoke: all configs × 3 corpora × 10 Qs with stubbed LLMs', () => {
  it('runs end-to-end without network in under 2 minutes', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-smoke-'));
    const corpora: BenchCorpus[] = [
      makeStubCorpus('longmemeval-s'),
      makeStubCorpus('locomo'),
      makeStubCorpus('internal'),
    ];
    const agentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'topic-stub', usage: { in: 100, out: 5 } }),
    };
    const judgeClient = {
      complete: vi.fn().mockResolvedValue({ text: 'VERDICT: correct\nREASON: ok', usage: { in: 50, out: 5 } }),
    };
    const rerankClient = {
      async rerank(_q: string, docs: Array<{ docId: string; text: string }>) {
        return { reranked: docs.map((d, i) => ({ docId: d.docId, score: 1 - i * 0.01 })), tokens: 10 };
      },
    };
    const embedClient = {
      async embed(texts: string[]) {
        return { vectors: texts.map((t) => Array.from({ length: 4 }, (_, i) => (t.length + i) % 100 / 100)), tokens: texts.length * 10 };
      },
    };
    const drivers = [
      createConfigA({ tempDir: dir }),
      createConfigB({ tempDir: dir, rerankClient }),
      createConfigC({ tempDir: dir, embedClient, embeddingDim: 4 }),
    ];
    for (const corpus of corpora) {
      for (const driver of drivers) {
        await driver.build(corpus);
        try {
          for (const q of corpus.questions) {
            const r = await driver.retrieve(q, 5, new AbortController().signal);
            const a = await runAgent(agentClient, q, r.retrievedDocs);
            const v = await judgeAnswer(judgeClient, q.text, q.goldAnswer, a.text);
            expect(v.verdict).toBe('correct');
          }
        } finally {
          await driver.teardown();
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
