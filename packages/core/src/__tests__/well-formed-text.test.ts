import { describe, expect, it } from 'vitest';
import {
  stringifyWellFormed,
  toWellFormedText,
  toWellFormedValue,
} from '../well-formed-text.js';

// TASK-1059: Postgres refuses U+0000 and lone surrogates in jsonb (and text),
// so a message carrying one failed on every attempt. These helpers swap them
// for U+FFFD. The real-Postgres round trip is in @ax/conversations'
// display-events.test.ts; the orchestrator's use is in its
// route-by-conversation test (mocked writers).

const R = '\uFFFD';
const SMILE = '\ud83d\ude00'; // U+1F600, a real pair
const SKIN = '\ud83c\udfff'; // U+1F3FF: a real pair whose low half is \udfff
const MAX = '\udbff\udfff'; // U+10FFFF: high half \udbff, low half \udfff

/** The built-in, plus the NUL swap it does not do. Node has it at runtime even
 * though the ES2023 lib does not type it. */
function reference(s: string): string {
  return (s as unknown as { toWellFormed(): string }).toWellFormed().replaceAll('\u0000', R);
}

/** `v` with `reference` applied to every string and key. */
function referenceValue(v: unknown): unknown {
  if (typeof v === 'string') return reference(v);
  if (Array.isArray(v)) return v.map(referenceValue);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [reference(k), referenceValue(x)]));
  }
  return v;
}

/** No U+0000 and no lone surrogate anywhere in `s`. */
function wellFormed(s: string): boolean {
  if (s.includes('\u0000')) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe('toWellFormedText', () => {
  it.each([
    ['a\u0000b', `a${R}b`],
    ['\ud800', R],
    ['\udbff', R],
    ['\udc00', R],
    ['\udfff', R],
    // Two lone halves of the SAME kind in a row: neither pairs with the other.
    ['\ud800\ud800', `${R}${R}`],
    ['\udc00\udc00', `${R}${R}`],
    // Low then high is not a pair.
    ['\udc00\ud800', `${R}${R}`],
    // A lone half next to a real pair: only the lone half changes.
    [`\ud800${SMILE}`, `${R}${SMILE}`],
    [`${SMILE}\udc00`, `${SMILE}${R}`],
    // Real pairs at the edges of the surrogate ranges are kept whole.
    [SMILE, SMILE],
    [SKIN, SKIN],
    [MAX, MAX],
    ['plain', 'plain'],
  ])('%j -> %j', (input, expected) => {
    const out = toWellFormedText(input);
    expect(out).toBe(expected);
    expect(out).toBe(reference(input));
    expect(wellFormed(out)).toBe(true);
  });

  it('agrees with toWellFormed plus a NUL swap on EVERY string of up to 4 symbols', () => {
    // Exhaustive, not random: 8 symbols, lengths 0..4, 4681 strings. Each
    // surrogate half is drawn at both ends of its range.
    const symbols = ['a', '\u0000', '\ud800', '\udbff', '\udc00', '\udfff', SMILE, R];
    let strings = [''];
    let all = [''];
    for (let len = 1; len <= 4; len++) {
      strings = strings.flatMap((s) => symbols.map((c) => s + c));
      all = all.concat(strings);
    }
    expect(all).toHaveLength(4681);
    for (const s of all) {
      const out = toWellFormedText(s);
      expect(out).toBe(reference(s));
      expect(wellFormed(out)).toBe(true);
    }
  });
});

describe('stringifyWellFormed', () => {
  it('is JSON.stringify for ordinary values', () => {
    const v = { a: 'x', b: [1, 'y', null, true], c: { d: 'z' }, e: SMILE, f: SKIN, g: MAX };
    expect(stringifyWellFormed(v)).toBe(JSON.stringify(v));
  });

  it('fixes string values, nested and in arrays', () => {
    expect(JSON.parse(stringifyWellFormed({ t: ['a\u0000', { u: '\ud800\ud800' }] }))).toEqual({
      t: [`a${R}`, { u: `${R}${R}` }],
    });
  });

  it('fixes object keys', () => {
    expect(JSON.parse(stringifyWellFormed([{ 'k\u0000': { 'x\ud800': 'v' } }]))).toEqual([
      { [`k${R}`]: { [`x${R}`]: 'v' } },
    ]);
  });

  // Each input carries exactly ONE kind of problem, so each half of the cheap
  // pre-check (NUL, and each surrogate range) has to send it down the fixing
  // path on its own.
  it.each([
    [{ t: 'x\u0000' }, { t: `x${R}` }],
    [{ ['k\u0000']: 'v' }, { [`k${R}`]: 'v' }],
    [{ t: 'x\ud800' }, { t: `x${R}` }],
    [{ t: 'x\udbff' }, { t: `x${R}` }],
    [{ t: 'x\udfff' }, { t: `x${R}` }],
    [{ t: 'x\udc00y' }, { t: `x${R}y` }],
    [{ ['k\udc00']: 'v' }, { [`k${R}`]: 'v' }],
  ])('fixes a single kind of problem on its own: %j', (input, expected) => {
    expect(JSON.parse(stringifyWellFormed(input))).toEqual(expected);
    expect(toWellFormedValue(input)).toEqual(expected);
  });

  it('matches the reference on every string and key, on random values', () => {
    const alphabet = ['a', '\u0000', '\ud800', '\udbff', '\udc00', '\udfff', SMILE, SKIN, R, '\\', 'u', 'd', '8'];
    // A 32-bit LCG. Math.imul keeps the product exact (a plain multiply goes
    // past 2^53 and collapses to a handful of values), and the high bits are
    // the well-mixed ones.
    let seed = 7;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return (seed >>> 16) % n;
    };
    const drawn = new Set<string>();
    const str = () => {
      let s = '';
      const len = rand(6);
      for (let j = 0; j < len; j++) {
        const c = alphabet[rand(alphabet.length)]!;
        drawn.add(c);
        s += c;
      }
      return s;
    };
    for (let i = 0; i < 2000; i++) {
      const v = { [str()]: str(), list: [str(), { [str()]: str() }] };
      const expected = referenceValue(v);
      expect(JSON.parse(stringifyWellFormed(v))).toEqual(expected);
      expect(toWellFormedValue(v)).toEqual(expected);
    }
    // A generator that collapses would quietly stop drawing most symbols.
    expect([...drawn].sort()).toEqual([...alphabet].sort());
  });

  // Every lone surrogate, not just the range edges: a cut emoji leaves an
  // interior one ('😀'.slice(1) is \ude00), and the cheap pre-check has to
  // send each of the 2048 down the fixing path.
  it('fixes every lone surrogate U+D800..U+DFFF, in values and keys', () => {
    for (let u = 0xd800; u <= 0xdfff; u++) {
      const t = `x${String.fromCharCode(u)}`;
      expect(toWellFormedText(t)).toBe(reference(t));
      const v = { t, [t]: 'k' };
      const expected = referenceValue(v);
      expect(JSON.parse(stringifyWellFormed(v))).toEqual(expected);
      expect(toWellFormedValue(v)).toEqual(expected);
    }
  });

  it.each([
    ['high half', SMILE.slice(0, 1)],
    ['low half', SMILE.slice(1)],
  ])('fixes a cut emoji (%s)', (_name, half) => {
    expect(JSON.parse(stringifyWellFormed({ t: `cut ${half}` }))).toEqual({ t: `cut ${R}` });
  });

  it('leaves a string that only LOOKS like an escape alone', () => {
    const v = { t: 'a literal \\u0000 and \\ud800' };
    expect(JSON.parse(stringifyWellFormed(v))).toEqual(v);
  });
});

describe('toWellFormedValue', () => {
  it('returns the same reference when there is nothing to fix', () => {
    const v = { role: 'user', content: 'hello', contentBlocks: [{ type: 'text', text: 'x' }] };
    expect(toWellFormedValue(v)).toBe(v);
  });

  it('returns a fixed copy otherwise, leaving the input alone', () => {
    const v = { content: 'a\u0000', contentBlocks: [{ type: 'text', text: '\udc00' }] };
    expect(toWellFormedValue(v)).toEqual({
      content: `a${R}`,
      contentBlocks: [{ type: 'text', text: R }],
    });
    expect(v.content).toBe('a\u0000');
  });
});
