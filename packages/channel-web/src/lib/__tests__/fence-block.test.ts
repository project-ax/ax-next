import { describe, expect, it } from 'vitest';
import { fenceBlock } from '../fence-line';

/**
 * TASK-699 — the approval card's "what it will send" block. Agent-authored
 * text, so every way it could rewrite the surface or swamp the card is pinned.
 */
describe('fenceBlock', () => {
  it('keeps newlines and indentation — a JSON block stays readable', () => {
    expect(fenceBlock('{\n  "a": 1\n}', 100, 10)).toEqual({ text: '{\n  "a": 1\n}', truncated: false });
  });

  it('spells out bidi, zero-width, line-separator and control characters instead of dropping them', () => {
    const out = fenceBlock('a\u202Eb\u200Bc\u2028d\u0007e\uFEFFf', 100, 10)!;
    expect(out.text).toBe('a\\u202eb\\u200bc\\u2028d\\u0007e\\ufefff');
    expect(out.truncated).toBe(false);
  });

  it('turns TAB into spaces and drops CR so CRLF stays one break', () => {
    expect(fenceBlock('a\tb\r\nc', 100, 10)).toEqual({ text: 'a  b\nc', truncated: false });
  });

  it('caps by code points and says so, never splitting a surrogate pair', () => {
    const out = fenceBlock('😀'.repeat(50), 10, 10)!;
    expect([...out.text]).toHaveLength(10);
    expect(out.text).toBe('😀'.repeat(10));
    expect(out.truncated).toBe(true);
  });

  it('never splits an escape across the cap', () => {
    const out = fenceBlock('abcd\u202E', 6, 10)!;
    expect(out.text).toBe('abcd');
    expect(out.truncated).toBe(true);
  });

  it('caps by lines and says so', () => {
    const out = fenceBlock(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), 10_000, 5)!;
    expect(out.text.split('\n')).toEqual(['l0', 'l1', 'l2', 'l3', 'l4']);
    expect(out.truncated).toBe(true);
  });

  it('bounds the work on a huge input and reports the cut', () => {
    const out = fenceBlock('x'.repeat(5_000_000), 2000, 40)!;
    expect(out.text).toHaveLength(2000);
    expect(out.truncated).toBe(true);
  });

  it('strips trailing whitespace in one pass, so a long blank run costs nothing (TASK-906)', () => {
    // A whole task brief reaches this block now. `replace(/\s+$/, '')` backtracked over every
    // interior run of whitespace, quadratic in its length: about two seconds for 65,000 spaces.
    const value = `a${' '.repeat(120_000)}b${'  \n '.repeat(3)}`;
    const started = performance.now();
    const out = fenceBlock(value, 300_000, 100)!;
    expect(performance.now() - started).toBeLessThan(250);
    expect(out).toEqual({ text: `a${' '.repeat(120_000)}b`, truncated: false });
  });

  it('still strips each trailing whitespace character the old pattern did', () => {
    // The spaces that survive the fence: the rest of the whitespace set is escaped or dropped first.
    const spaces = String.fromCodePoint(0x20, 0xa0, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000);
    expect(fenceBlock(`a${spaces}\n${spaces}`, 100, 10)).toEqual({ text: 'a', truncated: false });
  });

  it('exactly at the cap is not truncated', () => {
    expect(fenceBlock('x'.repeat(10), 10, 1)).toEqual({ text: 'x'.repeat(10), truncated: false });
  });

  it('answers null for nothing legible', () => {
    expect(fenceBlock(undefined, 10, 10)).toBeNull();
    expect(fenceBlock(null, 10, 10)).toBeNull();
    expect(fenceBlock('  \n \r\n', 10, 10)).toBeNull();
  });
});
