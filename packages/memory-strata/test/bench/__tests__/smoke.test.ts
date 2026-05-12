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
      async embed(texts: string[], _inputType: 'document' | 'query') {
        return { vectors: texts.map((t) => Array.from({ length: 4 }, (_, i) => (t.length + i) % 100 / 100)), tokens: texts.length * 10 };
      },
    };
    const drivers = [
      createConfigA({ tempDir: dir }),
      createConfigB({ tempDir: dir, rerankClient }),
      createConfigC({ tempDir: dir, embedClient, embeddingDim: 4 }),
    ];
    try {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.BENCH_LIVE !== '1')('Live smoke (BENCH_LIVE=1, hard-fails above $0.50)', () => {
  it('runs one question with Config C against the internal corpus', { timeout: 60_000 }, async () => {
    const env = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ZEROENTROPY_API_KEY: process.env.ZEROENTROPY_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    if (!env.ANTHROPIC_API_KEY || !env.ZEROENTROPY_API_KEY || !env.OPENROUTER_API_KEY) {
      throw new Error('Missing API keys for live smoke');
    }
    const { loadInternalCorpus } = await import('../corpora/internal.js');
    const corpus = loadInternalCorpus();
    expect(corpus.questions.length).toBeGreaterThan(0);

    const { createConfigC, makeZeroEntropyEmbedClient } = await import('../configs/c-rrf.js');
    const { makeAnthropicAgentClient } = await import('../agent.js');
    const { makeOpenRouterJudgeClient } = await import('../judge.js');
    const { CostMeter } = await import('../meter.js');

    const meter = new CostMeter({ capDollars: 0.5, pricing: {
      'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
      'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
      'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
      'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
    }});

    const dir = mkdtempSync(join(tmpdir(), 'bench-live-'));
    const driver = createConfigC({ tempDir: dir, embedClient: makeZeroEntropyEmbedClient(env.ZEROENTROPY_API_KEY) });
    let spent: number;
    try {
      await driver.build(corpus);
      const question = corpus.questions[0]!;
      const r = await driver.retrieve(question, 5, new AbortController().signal);
      meter.record('zembed-1', { in: r.embeddingTokens, out: 0 });

      const a = await runAgent(makeAnthropicAgentClient(env.ANTHROPIC_API_KEY), question, r.retrievedDocs);
      meter.record('claude-sonnet-4-6', a.usage);

      const v = await judgeAnswer(makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY), question.text, question.goldAnswer, a.text);
      meter.record('x-ai/grok-4.3', v.usage);

      spent = meter.totalDollars();
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }

    console.log(
      `[live-smoke] spent $${spent.toFixed(4)} across ${Object.keys(meter.snapshot()).length} models:`,
      meter.snapshot(),
    );
    expect(spent).toBeLessThan(0.5);
  });
});
