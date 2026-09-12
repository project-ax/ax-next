import { describe, it, expect } from 'vitest';
import { renderReport } from '../report.js';
import type { QuestionResult, Verdict, ConfigName } from '../types.js';

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

  it('renders an abstention table with correct-refusal rate', () => {
    const mk = (id: string, verdict: Verdict, unanswerable: boolean): QuestionResult => ({
      corpus: 'longmemeval-s',
      config: 'd-map',
      question: { id, text: 'q', goldAnswer: 'g', ...(unanswerable ? { metadata: { unanswerable: true } } : {}) },
      retrieval: { retrievedDocs: [], latencyMs: 0, embeddingTokens: 0, rerankTokens: 0 },
      agentAnswer: 'a',
      verdict,
      judgeReason: '',
      agentTokens: { in: 0, out: 0 },
      judgeTokens: { in: 0, out: 0 },
      totalDollars: 0,
    });
    const results: QuestionResult[] = [
      mk('a_abs', 'abstained-correctly', true),
      mk('c_abs', 'incorrect', true),
      mk('d', 'correct', false),
      mk('e', 'abstained-incorrectly', false),
    ];
    const md = renderReport({ results, cap: 50, totalSpent: 0, capExceeded: false, runDate: new Date('2026-05-14') });
    expect(md).toContain('## Abstention');
    expect(md).toContain('D: Retrieval Orchestrator');
    // 1 of 2 unanswerable questions correctly refused -> 50.0%
    expect(md).toContain('correct-refusal');
    expect(md).toContain('50.0%');
  });

  it('renders d-map and e-map-fts labels', () => {
    const mk = (config: ConfigName): QuestionResult => ({
      corpus: 'longmemeval-s',
      config,
      question: { id: 'q', text: 'q', goldAnswer: 'g' },
      retrieval: { retrievedDocs: [], latencyMs: 0, embeddingTokens: 0, rerankTokens: 0 },
      agentAnswer: 'a',
      verdict: 'correct',
      judgeReason: '',
      agentTokens: { in: 0, out: 0 },
      judgeTokens: { in: 0, out: 0 },
      totalDollars: 0,
    });
    const md = renderReport({
      results: [mk('d-map'), mk('e-map-fts')],
      cap: 50, totalSpent: 0, capExceeded: false, runDate: new Date('2026-05-14'),
    });
    expect(md).toContain('D: Retrieval Orchestrator');
    expect(md).toContain('E: Orchestrator + BM25 fallback');
  });

  it('counts abstained-correctly toward headline accuracy', () => {
    const mk = (id: string, verdict: Verdict): QuestionResult => ({
      corpus: 'longmemeval-s', config: 'd-map',
      question: { id, text: 'q', goldAnswer: 'g', metadata: { unanswerable: true } },
      retrieval: { retrievedDocs: [], latencyMs: 0, embeddingTokens: 0, rerankTokens: 0 },
      agentAnswer: 'a', verdict, judgeReason: '',
      agentTokens: { in: 0, out: 0 }, judgeTokens: { in: 0, out: 0 }, totalDollars: 0,
    });
    const md = renderReport({
      results: [mk('1', 'correct'), mk('2', 'abstained-correctly')],
      cap: 50, totalSpent: 0, capExceeded: false, runDate: new Date('2026-05-14'),
    });
    // 2 of 2 are "correct" in the headline aggregation
    expect(md).toMatch(/D: Retrieval Orchestrator[^\n]*\|\s*2\s*\|\s*100\.0%/i);
  });
});

describe('renderReport — orchestrator model stamp', () => {
  it('stamps the model when an orchestrator config ran', () => {
    // Config D and E carry the same label in every report, so two arms that
    // differ only by orchestrator model are otherwise indistinguishable after
    // the fact — which is how a headline measured against a since-deprecated
    // model id outlived the id by four months (#515).
    const md = renderReport({
      results: [makeResult({ config: 'e-map-fts' })],
      cap: 50,
      totalSpent: 0.001,
      capExceeded: false,
      runDate: new Date('2026-09-11T00:00:00Z'),
      orchestratorModel: 'z-ai/glm-5.3-flash:nitro',
    });
    expect(md).toContain('**Orchestrator model:** `z-ai/glm-5.3-flash:nitro`');
  });

  it('omits the stamp when no orchestrator config ran', () => {
    // A BM25-only run does not call the orchestrator at all. Stamping a model
    // on it would assert a dependency the numbers do not have.
    const md = renderReport({
      results: [makeResult({ config: 'a-bm25' })],
      cap: 50,
      totalSpent: 0.001,
      capExceeded: false,
      runDate: new Date('2026-09-11T00:00:00Z'),
      orchestratorModel: 'claude-haiku-4-5-20251001',
    });
    expect(md).not.toContain('Orchestrator model');
  });
});

describe('renderReport — spend by model', () => {
  it('breaks the bill down per model, so the total is not read as the planner', () => {
    // The planner is the only role that differs between arms, which makes a
    // bare total easy to misattribute to it. In practice the answer model
    // dominates, and a cheaper-looking arm is usually one whose planner handed
    // the answer model FEWER documents to read — a different finding entirely.
    const md = renderReport({
      results: [makeResult({ config: 'e-map-fts' })],
      cap: 50,
      totalSpent: 10,
      capExceeded: false,
      runDate: new Date('2026-09-11T00:00:00Z'),
      spendByModel: {
        'claude-sonnet-4-6': { tokensIn: 3_000_000, tokensOut: 100_000, dollars: 10.5 },
        'z-ai/glm-5.3-flash:nitro': { tokensIn: 1_000_000, tokensOut: 50_000, dollars: 0.175 },
        'never-called': { tokensIn: 0, tokensOut: 0, dollars: 0 },
      },
    });
    expect(md).toContain('## Spend by model');
    expect(md).toContain('`claude-sonnet-4-6` | 3,000,000 | 100,000 | $10.5000 | 98.4%');
    expect(md).toContain('`z-ai/glm-5.3-flash:nitro` | 1,000,000 | 50,000 | $0.1750 | 1.6%');
    // A model with a pricing row but no calls is noise, not a zero-dollar fact.
    expect(md).not.toContain('never-called');
  });

  it('omits the section when the meter was never fed', () => {
    const md = renderReport({
      results: [makeResult()],
      cap: 50,
      totalSpent: 0,
      capExceeded: false,
      runDate: new Date('2026-09-11T00:00:00Z'),
    });
    expect(md).not.toContain('## Spend by model');
  });
});

describe('renderReport — plan shape', () => {
  const planResult = (over: Partial<QuestionResult['retrieval']>, config: ConfigName = 'e-map-fts') =>
    makeResult({
      config,
      retrieval: {
        retrievedDocs: [{ path: 'a', score: 1, summary: 's' }],
        latencyMs: 10,
        embeddingTokens: 0,
        rerankTokens: 0,
        orchestratorDocCount: 3,
        ...over,
      },
    });

  it('reports how much retrieval the planner actually did', () => {
    // The question this answers: is this an orchestrator run, or BM25 wearing
    // an orchestrator's label? The fallback's rows are appended to the
    // planner's, so retrievedDocs alone cannot tell them apart afterwards.
    const md = renderReport({
      results: [
        planResult({ orchestratorDocCount: 4 }),
        planResult({ orchestratorDocCount: 0, followupNeeded: true, fellBackToBm25: true }),
      ],
      cap: 50,
      totalSpent: 1,
      capExceeded: false,
      runDate: new Date('2026-09-11T00:00:00Z'),
    });
    expect(md).toContain('## Plan shape');
    expect(md).toContain('| 2 | 2.00 | 50.0% | 50.0% | 50.0% |');
  });

  it('omits the section for configs that run no planner', () => {
    const md = renderReport({
      results: [planResult({}, 'a-bm25')],
      cap: 50,
      totalSpent: 1,
      capExceeded: false,
      runDate: new Date('2026-09-11T00:00:00Z'),
    });
    expect(md).not.toContain('## Plan shape');
  });
});

describe('renderReport — measurement-condition stamps', () => {
  it('stamps how the questions were drawn and what the body cap was', () => {
    // Both of these moved results by double digits without changing a single
    // line of retrieval code: a corpus-order prefix draws one question type,
    // and the body cap moved accuracy 24 points. A report that omits them
    // invites comparison against a run that used different ones.
    const md = renderReport({
      results: [makeResult()],
      cap: 50,
      totalSpent: 1,
      capExceeded: false,
      runDate: new Date('2026-09-12T00:00:00Z'),
      sampleNote: '--sample 150 (stratified by question_type) -> multi-session=40',
      bodyCharCap: 20000,
    });
    expect(md).toContain('**Sampling:** --sample 150 (stratified by question_type)');
    expect(md).toContain('**Answer-stage body cap:** 20,000 chars/doc');
  });

  it('omits both when the caller does not supply them', () => {
    const md = renderReport({
      results: [makeResult()],
      cap: 50,
      totalSpent: 1,
      capExceeded: false,
      runDate: new Date('2026-09-12T00:00:00Z'),
    });
    expect(md).not.toContain('**Sampling:**');
    expect(md).not.toContain('body cap');
  });
});
