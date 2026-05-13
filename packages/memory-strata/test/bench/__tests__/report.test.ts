import { describe, it, expect } from 'vitest';
import { renderReport } from '../report.js';
import type { QuestionResult } from '../types.js';

function makeResult(overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
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
    ...overrides,
  };
}

const sampleResult: QuestionResult = makeResult();

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

  it('recall@5 denominator counts only gold-doc-eligible questions', () => {
    // 2 results WITH goldDocIds (both hit their gold doc in top-5)
    const eligible1 = makeResult({
      question: { id: 'q1', text: 'x?', goldAnswer: 'y', goldDocIds: ['a'] },
      retrieval: { retrievedDocs: [{ path: 'a', score: 1, summary: 's' }], latencyMs: 10, embeddingTokens: 0, rerankTokens: 0 },
    });
    const eligible2 = makeResult({
      question: { id: 'q2', text: 'x?', goldAnswer: 'y', goldDocIds: ['b'] },
      retrieval: { retrievedDocs: [{ path: 'b', score: 1, summary: 's' }], latencyMs: 10, embeddingTokens: 0, rerankTokens: 0 },
    });
    // 2 results WITHOUT goldDocIds (should not reduce the denominator)
    const ineligible1 = makeResult({ question: { id: 'q3', text: 'x?', goldAnswer: 'y' } });
    const ineligible2 = makeResult({ question: { id: 'q4', text: 'x?', goldAnswer: 'y', goldDocIds: [] } });

    const md = renderReport({
      results: [eligible1, eligible2, ineligible1, ineligible2],
      cap: 50,
      totalSpent: 0.01,
      capExceeded: false,
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    // 2 hits out of 2 eligible → 100.0%, not 50.0%
    expect(md).toContain('100.0%');
    expect(md).not.toContain('50.0%');
  });

  it('marks the report as aborted when an abortError is set', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 0.5,
      capExceeded: false,
      abortError: 'read ETIMEDOUT',
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    expect(md).toMatch(/Aborted: read ETIMEDOUT/);
    expect(md).toMatch(/partial results captured before the abort/);
  });

  it('lists config build failures distinct from per-question skips', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 0.01,
      capExceeded: false,
      runDate: new Date('2026-05-12T00:00:00Z'),
      configFailures: [
        { corpus: 'longmemeval-s', config: 'c-rrf', phase: 'build', reason: '500 Internal Server Error' },
      ],
    });
    expect(md).toContain('Config build failures (1)');
    expect(md).toMatch(/longmemeval-s \/ c-rrf.*build.*500 Internal Server Error/);
  });

  it('lists skipped questions bucketed by reason', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 0.01,
      capExceeded: false,
      runDate: new Date('2026-05-12T00:00:00Z'),
      skipped: [
        { corpus: 'longmemeval-s', config: 'a-bm25', questionId: 'q1', reason: '400 content filtering policy' },
        { corpus: 'longmemeval-s', config: 'a-bm25', questionId: 'q2', reason: '400 content filtering policy' },
        { corpus: 'longmemeval-s', config: 'b-rerank', questionId: 'q5', reason: 'rerank timeout' },
      ],
    });
    expect(md).toContain('Skipped questions (3)');
    expect(md).toMatch(/2× — 400 content filtering policy/);
    expect(md).toMatch(/1× — rerank timeout/);
  });

  it('recall@5 is 0 when no eligible questions', () => {
    const noGold = makeResult({ question: { id: 'q1', text: 'x?', goldAnswer: 'y' } });
    const md = renderReport({
      results: [noGold],
      cap: 50,
      totalSpent: 0.001,
      capExceeded: false,
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    expect(md).toContain('0.0%');
  });
});
