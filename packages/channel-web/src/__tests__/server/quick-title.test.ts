import { describe, expect, it } from 'vitest';
import { KICKOFF_TEXT } from '../../lib/bootstrap-kickoff.js';
import { QUICK_TITLE_MAX_CHARS, quickTitle } from '../../server/quick-title.js';

describe('quickTitle — a new chat named after its first message', () => {
  it('takes the first non-empty line, with runs of space flattened', () => {
    expect(quickTitle('\n\n  Plan the   offsite \nwith everyone')).toBe('Plan the offsite');
  });

  it('keeps a short message whole', () => {
    expect(quickTitle('What is on today?')).toBe('What is on today?');
  });

  it('ends a long line on a word, with an ellipsis, within the limit', () => {
    const t = quickTitle(
      'Can you pull together everything we know about the vendor shortlist for the Q3 review',
    )!;
    expect([...t].length).toBeLessThanOrEqual(QUICK_TITLE_MAX_CHARS);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toBe('Can you pull together everything we know about the vendor…');
  });

  it('cuts a long word-free line at the limit rather than leaving it empty', () => {
    const t = quickTitle('x'.repeat(200))!;
    expect(t).toHaveLength(QUICK_TITLE_MAX_CHARS);
    expect(t.endsWith('…')).toBe(true);
  });

  it('never cuts a character in half — flags and joined emoji included', () => {
    const graphemes = (t: string) =>
      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)].map((g) => g.segment);
    for (const ch of ['🎉', '🇯🇵', '👩‍👩‍👧', 'e\u0301']) {
      const t = quickTitle(ch.repeat(100))!;
      const parts = graphemes(t);
      expect(parts).toHaveLength(QUICK_TITLE_MAX_CHARS);
      // Every character but the trailing ellipsis is the whole original one.
      expect(parts.slice(0, -1).every((p) => p === ch)).toBe(true);
    }
  });

  it('drops control characters', () => {
    expect(quickTitle('Hello\u0007\u001b[31m world')).toBe('Hello [31m world');
  });

  it('has nothing to say for an empty or whitespace message (a file alone)', () => {
    expect(quickTitle('')).toBeNull();
    expect(quickTitle(' \n\t ')).toBeNull();
  });

  it('never names a chat after the hidden greeting that wakes a new agent', () => {
    expect(quickTitle(KICKOFF_TEXT)).toBeNull();
  });
});
