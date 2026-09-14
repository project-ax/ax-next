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

describe('e2e report provenance', () => {
  const base = {
    rows: [],
    runDate: new Date('2026-09-14T00:00:00Z'),
    requestedSample: 100,
    cap: 60,
    totalSpent: 7.28,
    capExceeded: false,
    answerModel: 'claude-sonnet-4-6',
    extractionModel: 'z-ai/glm-5.3-flash:nitro',
    judgeModel: 'x-ai/grok-4.3',
    command: 'pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --orchestrator-model glm',
  };

  it('never prints a hardcoded vendor beside a model id', () => {
    // This said "(Anthropic)" next to a z-ai model for a full run. A label that
    // has to be maintained in lockstep with a model id will eventually lie.
    const md = renderE2EReport({ ...base, retrievalMode: 'bm25' });
    expect(md).toContain('`z-ai/glm-5.3-flash:nitro`');
    expect(md).not.toMatch(/z-ai\/glm-5\.3-flash:nitro`? \(Anthropic\)/);
  });

  it('names the planner and does not cite the retired xAI latency claim', () => {
    const md = renderE2EReport({
      ...base,
      retrievalMode: 'orchestrator',
      orchestratorModel: 'z-ai/glm-5.3-flash:nitro',
    });
    expect(md).toContain('planner=`z-ai/glm-5.3-flash:nitro`');
    expect(md).not.toContain('direct-xAI');
  });

  it('prints the command that actually reproduces the run', () => {
    // It used to omit the planner arm, so the printed command reproduced the
    // DEFAULT arm — a different run than the one it was printed on.
    const md = renderE2EReport({ ...base, retrievalMode: 'orchestrator' });
    expect(md).toContain('--orchestrator-model glm');
  });

  it('stamps HOW the sample was drawn, not just how many were asked for', () => {
    // n=100 alone cannot distinguish a stratified draw from `--first 100`,
    // which on this type-blocked corpus contains ZERO knowledge-update
    // questions. The isolated bench report has stamped this since the sampling
    // fix; e2e — the harness whose number is quoted as product quality — did
    // not, so its reports were the ones that could not be told apart.
    const md = renderE2EReport({
      ...base,
      sampleNote: '--sample 100 (stratified by question_type) -> multi-session=27 temporal-reasoning=27',
    });
    expect(md).toContain('**Sampling:**');
    expect(md).toContain('stratified by question_type');
    expect(md).toContain('temporal-reasoning=27');
  });

  it('distinguishes a type-biased prefix run from a stratified one', () => {
    const biased = renderE2EReport({
      ...base,
      sampleNote: '--first 100 (corpus-order prefix, type-biased) -> single-session-user=70 multi-session=30',
    });
    expect(biased).toContain('type-biased');
    expect(biased).not.toContain('stratified by question_type');
  });

  it('omits the line entirely rather than printing an empty one', () => {
    expect(renderE2EReport({ ...base })).not.toContain('**Sampling:**');
  });
});
