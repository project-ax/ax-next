import { describe, it, expect } from 'vitest';
import { renderReport } from '../report.js';
import type { QuestionResult } from '../types.js';

const sampleResult: QuestionResult = {
  corpus: 'internal',
  config: 'a-bm25',
  question: { id: 'q1', text: 'x?', goldAnswer: 'y' },
  retrieval: { retrievedDocs: [{ path: 'a', score: 1, summary: 's' }], latencyMs: 10, embeddingTokens: 0, rerankTokens: 0 },
  agentAnswer: 'y',
  verdict: 'correct',
  judgeReason: 'matches',
  agentTokens: { in: 100, out: 5 },
  judgeTokens: { in: 50, out: 5 },
  totalDollars: 0.001,
};

describe('renderReport', () => {
  it('produces markdown with per-corpus tables and a decision section', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 0.001,
      capExceeded: false,
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    expect(md).toContain('# Strata vector-vs-no-vector spike report');
    expect(md).toContain('2026-05-12');
    expect(md).toContain('| internal');
    expect(md).toContain('Binding decision');
  });

  it('marks the report as aborted when cap is exceeded', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 50.01,
      capExceeded: true,
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    expect(md).toMatch(/Aborted: cost cap exceeded/);
  });
});
