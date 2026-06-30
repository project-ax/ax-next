import { describe, it, expect } from 'vitest';
import { renderE2EReport, type E2EReportRow } from '../e2e-report.js';

function row(over: Partial<E2EReportRow>): E2EReportRow {
  return {
    questionId: 'q',
    questionType: 'single-session-user',
    unanswerable: false,
    verdict: 'correct',
    judgeReason: 'ok',
    sessionsIngested: 10,
    toolCalls: 1,
    dollars: 0.01,
    ...over,
  };
}

describe('renderE2EReport (TASK-189)', () => {
  it('names the answer LLM, extraction LLM, and judge in the header', () => {
    const md = renderE2EReport({
      rows: [row({})],
      runDate: new Date('2026-06-29T00:00:00Z'),
      requestedSample: 100,
      cap: 25,
      totalSpent: 3.2,
      capExceeded: false,
      answerModel: 'claude-sonnet-4-6',
      extractionModel: 'claude-haiku-4-5-20251001',
      judgeModel: 'x-ai/grok-4.3',
      command: 'pnpm bench --mode e2e --sample 100',
    });
    expect(md).toContain('claude-sonnet-4-6');
    expect(md).toContain('claude-haiku-4-5-20251001');
    expect(md).toContain('x-ai/grok-4.3');
    expect(md).toContain('Strata end-to-end LongMemEval-S report');
  });

  it('computes end-to-end accuracy as correct + abstained-correctly', () => {
    const md = renderE2EReport({
      rows: [
        row({ verdict: 'correct', unanswerable: false }),
        row({ verdict: 'incorrect', unanswerable: false }),
        row({ verdict: 'abstained-correctly', unanswerable: true }),
        row({ verdict: 'uncertain', unanswerable: false }),
      ],
      runDate: new Date('2026-06-29T00:00:00Z'),
      requestedSample: 4,
      cap: 25,
      totalSpent: 0.1,
      capExceeded: false,
      answerModel: 'm',
      extractionModel: 'e',
      judgeModel: 'j',
      command: 'cmd',
    });
    // 2 of 4 count as accurate (correct + abstained-correctly) = 50.0%.
    expect(md).toContain('**50.0%**');
  });

  it('emits correct-refusal, hallucination, and false-refusal rates for the _abs split', () => {
    const md = renderE2EReport({
      rows: [
        // 2 unanswerable: one correctly refused, one hallucinated.
        row({ verdict: 'abstained-correctly', unanswerable: true }),
        row({ verdict: 'incorrect', unanswerable: true }),
        // 2 answerable: one correct, one false-refusal.
        row({ verdict: 'correct', unanswerable: false }),
        row({ verdict: 'abstained-incorrectly', unanswerable: false }),
      ],
      runDate: new Date('2026-06-29T00:00:00Z'),
      requestedSample: 4,
      cap: 25,
      totalSpent: 0.1,
      capExceeded: false,
      answerModel: 'm',
      extractionModel: 'e',
      judgeModel: 'j',
      command: 'cmd',
    });
    expect(md).toContain('## Abstention');
    expect(md).toContain('correct-refusal rate** (refused when it should) | 50.0%');
    expect(md).toContain('hallucination rate** (answered an unanswerable) | 50.0%');
    expect(md).toContain('false-refusal rate** (refused an answerable — missed retrieval) | 50.0%');
  });

  it('marks fixture mode and notes the c137 anchor caveat', () => {
    const md = renderE2EReport({
      rows: [row({})],
      runDate: new Date('2026-06-29T00:00:00Z'),
      requestedSample: 1,
      cap: 25,
      totalSpent: 0,
      capExceeded: false,
      answerModel: 'm',
      extractionModel: 'e',
      judgeModel: 'j',
      command: 'cmd',
      fixtureMode: true,
    });
    expect(md).toContain('fixture mode');
    expect(md).toContain('90.4%');
    expect(md).toContain('not');
  });
});
