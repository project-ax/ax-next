import { describe, it, expect } from 'vitest';
import { selectSamples, parseCsvFlag, seedResumeRows, zeroMatchError } from '../e2e-select.js';
import type { LongMemEvalSample } from '../corpora/longmemeval-s.js';
import type { E2EResumeRow } from '../e2e-resume.js';

/** Minimal sample; only question_id + question_type drive selection. */
function mk(id: string, type: string): LongMemEvalSample {
  return {
    question_id: id,
    question_type: type,
    question: 'q',
    answer: 'a',
    haystack_session_ids: [],
    haystack_sessions: [],
  };
}

/** Mirrors the real corpus's TYPE-BLOCK ordering: the target type is last. */
function corpus(): LongMemEvalSample[] {
  const out: LongMemEvalSample[] = [];
  for (let i = 0; i < 100; i++) out.push(mk(`user-${i}`, 'single-session-user'));
  for (let i = 0; i < 20; i++) out.push(mk(`asst-${i}`, 'single-session-assistant'));
  return out;
}

describe('selectSamples', () => {
  it('with no filters is identical to slice(0, limit) — back-compat guard', () => {
    const all = corpus();
    expect(selectSamples({ samples: all, limit: 10 })).toEqual(all.slice(0, 10));
    expect(selectSamples({ samples: all, limit: 500 })).toEqual(all);
  });

  it('filters BEFORE the limit — the type-block trap', () => {
    // The assistant block starts at index 100. Filtering after a slice(0,100)
    // would yield ZERO rows; filtering first yields all 20.
    const rows = selectSamples({
      samples: corpus(),
      types: ['single-session-assistant'],
      limit: 100,
    });
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.question_type === 'single-session-assistant')).toBe(true);
  });

  it('selects explicit ids in corpus order', () => {
    const rows = selectSamples({ samples: corpus(), ids: ['asst-3', 'user-1'], limit: 500 });
    expect(rows.map((r) => r.question_id)).toEqual(['user-1', 'asst-3']);
  });

  it('unions types and ids', () => {
    const rows = selectSamples({
      samples: corpus(),
      types: ['single-session-assistant'],
      ids: ['user-0'],
      limit: 500,
    });
    expect(rows).toHaveLength(21);
    expect(rows[0]?.question_id).toBe('user-0');
  });

  it('still applies the limit to a filtered set', () => {
    const rows = selectSamples({
      samples: corpus(),
      types: ['single-session-assistant'],
      limit: 5,
    });
    expect(rows).toHaveLength(5);
  });

  it('returns empty (no throw) for an unknown type or id', () => {
    expect(selectSamples({ samples: corpus(), types: ['nope'], limit: 500 })).toEqual([]);
    expect(selectSamples({ samples: corpus(), ids: ['nope'], limit: 500 })).toEqual([]);
  });

  it('treats an empty filter list as no filter', () => {
    const all = corpus();
    expect(selectSamples({ samples: all, types: [], ids: [], limit: 500 })).toEqual(all);
  });
});

/** Minimal E2EResumeRow; only questionId drives the seeding logic under test. */
function mkRow(id: string): E2EResumeRow {
  return {
    questionId: id,
    questionType: 'single-session-user',
    unanswerable: false,
    verdict: 'correct',
    judgeReason: 'r',
    sessionsIngested: 1,
    toolCalls: 1,
    dollars: 0.01,
    question: 'q',
    goldAnswer: 'a',
    agentAnswer: 'a',
  };
}

describe('seedResumeRows (review fix — filtered-run row stranding)', () => {
  it('seeds only rows whose questionId is in the CURRENTLY selected sample set', () => {
    // "asst-0" is a row left over from a prior (differently-filtered, or
    // unfiltered) run sharing the same resume file — it must not leak into a
    // report for a run that didn't select it.
    const done = new Map<string, E2EResumeRow>([
      ['user-0', mkRow('user-0')],
      ['asst-0', mkRow('asst-0')],
    ]);
    const samples = [mk('user-0', 'single-session-user')];
    const rows = seedResumeRows(done, samples);
    expect(rows.map((r) => r.questionId)).toEqual(['user-0']);
  });

  it('seeds everything for an unfiltered run (samples = full corpus slice)', () => {
    const all = corpus();
    const done = new Map<string, E2EResumeRow>(all.map((s) => [s.question_id, mkRow(s.question_id)]));
    const rows = seedResumeRows(done, all);
    expect(rows).toHaveLength(all.length);
  });

  it('resuming the SAME filtered set keeps all its rows', () => {
    const samples = [mk('asst-0', 'single-session-assistant'), mk('asst-1', 'single-session-assistant')];
    const done = new Map<string, E2EResumeRow>(samples.map((s) => [s.question_id, mkRow(s.question_id)]));
    const rows = seedResumeRows(done, samples);
    expect(rows).toHaveLength(2);
  });
});

describe('zeroMatchError (review fix — zero-match integrity guard)', () => {
  it('returns an error when --types/--ids matched nothing', () => {
    const err = zeroMatchError({ types: ['nope'], ids: undefined, matched: 0 });
    expect(err).toBeDefined();
    expect(err).toContain('0 questions');
    expect(err).toContain('nope');
  });

  it('returns undefined when the selection matched something', () => {
    expect(zeroMatchError({ types: ['single-session-user'], ids: undefined, matched: 5 })).toBeUndefined();
  });

  it('returns undefined for an unfiltered run even if 0 samples were loaded', () => {
    // No --types/--ids requested at all — not this guard's concern.
    expect(zeroMatchError({ types: undefined, ids: undefined, matched: 0 })).toBeUndefined();
  });
});

describe('parseCsvFlag', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseCsvFlag('a, b ,,c')).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined for undefined or all-empty input', () => {
    expect(parseCsvFlag(undefined)).toBeUndefined();
    expect(parseCsvFlag('  , ')).toBeUndefined();
  });
});
