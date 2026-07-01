import { describe, it, expect } from 'vitest';
import { renderFairRerankReport, type FairRerankReportInput } from '../fair-reranker-report.js';
import type { QuestionResult, ConfigName, Verdict } from '../types.js';

function qr(
  config: ConfigName,
  verdict: Verdict,
  opts: { latencyMs?: number; rerankMs?: number; goldHit?: boolean; unanswerable?: boolean } = {},
): QuestionResult {
  const goldDocIds = opts.goldHit !== undefined ? ['episodes/gold'] : undefined;
  const retrievedDocs = opts.goldHit
    ? [{ path: 'episodes/gold', score: 1, summary: 's' }]
    : [{ path: 'episodes/other', score: 1, summary: 's' }];
  return {
    corpus: 'longmemeval-s',
    config,
    question: {
      id: opts.unanswerable ? 'q_abs' : 'q',
      text: 'q',
      goldAnswer: 'a',
      ...(goldDocIds ? { goldDocIds } : {}),
      ...(opts.unanswerable ? { metadata: { unanswerable: true } } : {}),
    },
    retrieval: {
      retrievedDocs,
      latencyMs: opts.latencyMs ?? 10,
      embeddingTokens: 0,
      rerankTokens: 0,
      ...(opts.rerankMs !== undefined ? { rerankMs: opts.rerankMs } : {}),
    },
    agentAnswer: 'x',
    verdict,
    judgeReason: 'r',
    agentTokens: { in: 100, out: 20 },
    judgeTokens: { in: 50, out: 10 },
    totalDollars: 0.001,
  };
}

const base: Omit<FairRerankReportInput, 'results' | 'verdictMode'> = {
  runDate: new Date('2026-06-29T00:00:00Z'),
  answerModel: 'claude-sonnet-4-6',
  judgeModel: 'x-ai/grok-4.3',
  rerankModel: 'mixedbread-ai/mxbai-rerank-large-v1',
  command: 'pnpm --filter @ax/memory-strata bench --config all',
  bm25CandidateCount: 50,
};

describe('renderFairRerankReport', () => {
  it('renders a needs-local-run stub with the exact command when there are no results', () => {
    const md = renderFairRerankReport({ ...base, verdictMode: 'needs-local-run', results: [] });
    expect(md).toContain('needs-local-run');
    expect(md).toContain(base.command);
    expect(md).toContain('mixedbread-ai/mxbai-rerank-large-v1');
    // Must NOT assert a measured verdict.
    expect(md).not.toMatch(/\bbeats BM25-only by\b/i);
  });

  it('declares a WIN when fair-F beats A by >= 5pp accuracy', () => {
    // A: 5/10 correct = 50%. F: 6/10 correct = 60% (+10pp >= 5pp threshold).
    const results: QuestionResult[] = [
      ...Array.from({ length: 5 }, () => qr('a-bm25', 'correct')),
      ...Array.from({ length: 5 }, () => qr('a-bm25', 'incorrect')),
      ...Array.from({ length: 6 }, () => qr('f-fair-rerank', 'correct')),
      ...Array.from({ length: 4 }, () => qr('f-fair-rerank', 'incorrect')),
    ];
    const md = renderFairRerankReport({ ...base, verdictMode: 'measured', results });
    expect(md).toMatch(/verdict/i);
    expect(md.toUpperCase()).toContain('WIN');
    expect(md).toContain('+10.0pp'); // delta surfaced
  });

  it('declares NO-WIN when fair-F is within 5pp of A', () => {
    // A: 6/10 = 60%. F: 6/10 = 60% (delta 0).
    const results: QuestionResult[] = [
      ...Array.from({ length: 6 }, () => qr('a-bm25', 'correct')),
      ...Array.from({ length: 4 }, () => qr('a-bm25', 'incorrect')),
      ...Array.from({ length: 6 }, () => qr('f-fair-rerank', 'correct')),
      ...Array.from({ length: 4 }, () => qr('f-fair-rerank', 'incorrect')),
    ];
    const md = renderFairRerankReport({ ...base, verdictMode: 'measured', results });
    expect(md.toUpperCase()).toMatch(/NO[- ]WIN|DOES NOT/);
    expect(md).toContain('reranker question is'); // "…finally closed" framing
  });

  it('surfaces recall@5 and the cross-encoder per-query latency line', () => {
    const results: QuestionResult[] = [
      qr('a-bm25', 'correct', { goldHit: true, latencyMs: 8 }),
      qr('f-fair-rerank', 'correct', { goldHit: true, latencyMs: 900, rerankMs: 850 }),
    ];
    const md = renderFairRerankReport({ ...base, verdictMode: 'measured', results });
    expect(md).toMatch(/recall@5/i);
    expect(md).toMatch(/cross-encoder/i);
    // The isolated rerank latency must appear.
    expect(md).toContain('850');
  });

  it('includes A, E, and F rows in the results table when all three present', () => {
    const results: QuestionResult[] = [
      qr('a-bm25', 'correct'),
      qr('e-map-fts', 'correct'),
      qr('f-fair-rerank', 'correct', { rerankMs: 500 }),
    ];
    const md = renderFairRerankReport({ ...base, verdictMode: 'measured', results });
    expect(md).toContain('A: BM25-only');
    expect(md).toContain('E: Orchestrator');
    expect(md).toContain('F: Fair reranker');
  });
});
