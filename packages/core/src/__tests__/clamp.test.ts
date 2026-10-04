import { describe, it, expect } from 'vitest';
import { clampCodeUnits } from '../clamp.js';
import { hold, HOLD_NOTE_MAX } from '../errors.js';

/** True when `s` holds a high surrogate with no low after it, or a low with no high before it. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe('clampCodeUnits', () => {
  it('returns a string at or under the ceiling unchanged', () => {
    expect(clampCodeUnits('abc', 3)).toBe('abc');
    expect(clampCodeUnits('', 3)).toBe('');
  });

  it('cuts an over-long string to exactly the ceiling', () => {
    expect(clampCodeUnits('abcdef', 4)).toBe('abcd');
  });

  it('never splits a surrogate pair straddling the cut — it drops the whole character', () => {
    // '\u{1F6AB}' is two code units at indices 3 and 4, so a naive
    // slice(0, 4) would keep a lone high surrogate.
    const out = clampCodeUnits('abc\u{1F6AB}tail', 4);
    expect(out).toBe('abc');
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('keeps a pair that ends exactly at the ceiling', () => {
    expect(clampCodeUnits('abc\u{1F6AB}tail', 5)).toBe('abc\u{1F6AB}');
  });
});

describe('hold() note clamp', () => {
  it('truncates a note whose boundary character is astral without leaving a lone surrogate', () => {
    const note = 'x'.repeat(HOLD_NOTE_MAX - 1) + '\u{1F6AB}' + 'tail';
    const h = hold({ decisionId: 'dec_1', note });
    expect(h.hold.note).toBe('x'.repeat(HOLD_NOTE_MAX - 1));
    expect(h.reason).toBe(h.hold.note);
    expect(hasLoneSurrogate(h.hold.note)).toBe(false);
  });
});
