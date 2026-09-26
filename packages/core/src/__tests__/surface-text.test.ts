import { describe, expect, it } from 'vitest';
import {
  HIDDEN_FORMAT_CHARS,
  REWRITES_THE_SURFACE,
  replaceSurfaceRewriters,
  stripSurfaceRewritersFromDocument,
} from '../surface-text.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** Every invisible / bidi format code point the class must cover. */
const FORMAT_POINTS = [
  0x061c,
  ...range(0x200b, 0x200f),
  0x2028,
  0x2029,
  ...range(0x202a, 0x202e),
  ...range(0x2060, 0x2064),
  ...range(0x2066, 0x2069),
  0xfeff,
];
const CONTROL_POINTS = [...range(0x0000, 0x001f), ...range(0x007f, 0x009f)];
const LAYOUT = new Set([0x09, 0x0a, 0x0d]);

describe('REWRITES_THE_SURFACE', () => {
  // TASK-562: the widening. Each of these passed through every copy but one.
  it.each([...range(0x2060, 0x2064), 0x2028, 0x2029].map((cp) => [hex(cp), cp]))(
    'matches %s (added by TASK-562)',
    (_label, cp) => {
      const c = String.fromCodePoint(cp);
      expect(REWRITES_THE_SURFACE.test(`a${c}b`)).toBe(true);
      expect(HIDDEN_FORMAT_CHARS.test(`a${c}b`)).toBe(true);
      expect(replaceSurfaceRewriters(`a${c}b`)).toBe('a b');
      expect(stripSurfaceRewritersFromDocument(`a${c}b`)).toBe('ab');
    },
  );

  it.each(FORMAT_POINTS.map((cp) => [hex(cp), cp]))('matches format char %s', (_l, cp) => {
    expect(REWRITES_THE_SURFACE.test(String.fromCodePoint(cp))).toBe(true);
    expect(HIDDEN_FORMAT_CHARS.test(String.fromCodePoint(cp))).toBe(true);
  });

  it.each(CONTROL_POINTS.map((cp) => [hex(cp), cp]))('matches control %s', (_l, cp) => {
    expect(REWRITES_THE_SURFACE.test(String.fromCodePoint(cp))).toBe(true);
  });

  it('leaves ordinary text alone — including neighbours of the ranges', () => {
    // U+2065 is unassigned and U+206A+ are outside this card's scope; U+2027
    // and U+202F border the ranges and are visible/ordinary spacing.
    const neighbours = [0x0020, 0x00a0, 0x200a, 0x2027, 0x202f, 0x205f, 0x2070, 0xfefe, 0xff01];
    for (const cp of neighbours) {
      expect(REWRITES_THE_SURFACE.test(String.fromCodePoint(cp)), hex(cp)).toBe(false);
    }
    expect(REWRITES_THE_SURFACE.test('Morning email pass — café 🎉')).toBe(false);
  });

  it('is not global, so repeated .test() calls cannot skip a match', () => {
    expect(REWRITES_THE_SURFACE.flags).not.toContain('g');
    expect(HIDDEN_FORMAT_CHARS.flags).not.toContain('g');
    const s = 'x‮y';
    expect([REWRITES_THE_SURFACE.test(s), REWRITES_THE_SURFACE.test(s)]).toEqual([true, true]);
  });
});

describe('HIDDEN_FORMAT_CHARS', () => {
  it('does not match controls — a document keeps its newlines and tabs', () => {
    for (const cp of CONTROL_POINTS) {
      expect(HIDDEN_FORMAT_CHARS.test(String.fromCodePoint(cp)), hex(cp)).toBe(false);
    }
  });
});

describe('replaceSurfaceRewriters', () => {
  it('replaces a RUN with one replacement', () => {
    expect(replaceSurfaceRewriters('Pay‮⁦​roll')).toBe('Pay roll');
    expect(replaceSurfaceRewriters('Pay‮⁦​roll', '')).toBe('Payroll');
  });

  it('is safe to call repeatedly (no shared lastIndex)', () => {
    expect(replaceSurfaceRewriters('a⁠b')).toBe('a b');
    expect(replaceSurfaceRewriters('a⁠b')).toBe('a b');
  });
});

describe('stripSurfaceRewritersFromDocument', () => {
  it('keeps tab, LF and CR and drops every other control', () => {
    for (const cp of CONTROL_POINTS) {
      const c = String.fromCodePoint(cp);
      expect(stripSurfaceRewritersFromDocument(`a${c}b`), hex(cp)).toBe(
        LAYOUT.has(cp) ? `a${c}b` : 'ab',
      );
    }
  });

  it('drops the line/paragraph separators — they are not CR/LF', () => {
    expect(stripSurfaceRewritersFromDocument('one two three\nfour')).toBe(
      'onetwothree\nfour',
    );
  });
});
