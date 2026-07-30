import { describe, it, expect } from 'vitest';
import { selectSamples, parseCsvFlag } from '../e2e-select.js';
import type { LongMemEvalSample } from '../corpora/longmemeval-s.js';

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

describe('parseCsvFlag', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseCsvFlag('a, b ,,c')).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined for undefined or all-empty input', () => {
    expect(parseCsvFlag(undefined)).toBeUndefined();
    expect(parseCsvFlag('  , ')).toBeUndefined();
  });
});
