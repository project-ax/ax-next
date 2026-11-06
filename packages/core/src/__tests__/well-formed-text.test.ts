import { describe, expect, it } from 'vitest';
import {
  stringifyWellFormed,
  toWellFormedText,
  toWellFormedValue,
} from '../well-formed-text.js';

// TASK-1059: Postgres refuses U+0000 and lone surrogates in jsonb (and text),
// so a message carrying one failed on every attempt. These helpers swap them
// for U+FFFD. The real-Postgres round trip is in @ax/conversations'
// display-events.test.ts and @ax/chat-orchestrator's route-by-conversation test.

const R = '\uFFFD';

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
    ['\udc00', R],
    // Two lone halves of the SAME kind in a row: neither pairs with the other.
    ['\ud800\ud800', `${R}${R}`],
    ['\udc00\udc00', `${R}${R}`],
    // Low then high is not a pair.
    ['\udc00\ud800', `${R}${R}`],
    // A lone half next to a real pair: only the lone half changes.
    ['\ud800😀', `${R}😀`],
    ['😀\udc00', `😀${R}`],
    ['😀', '😀'],
    ['plain', 'plain'],
  ])('%j -> %j', (input, expected) => {
    const out = toWellFormedText(input);
    expect(out).toBe(expected);
    expect(wellFormed(out)).toBe(true);
  });

  it('agrees with a reference check on random strings', () => {
    const alphabet = ['a', '\u0000', '\ud800', '\udbff', '\udc00', '\udfff', '😀', R];
    let seed = 1059;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      let s = '';
      const len = rand(8);
      for (let j = 0; j < len; j++) s += alphabet[rand(alphabet.length)];
      const out = toWellFormedText(s);
      expect(wellFormed(out)).toBe(true);
      expect(out.length).toBe(s.length);
    }
  });
});

describe('stringifyWellFormed', () => {
  it('is JSON.stringify for ordinary values', () => {
    const v = { a: 'x', b: [1, 'y', null, true], c: { d: 'z' }, e: '😀' };
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
