import { describe, it, expect } from 'vitest';
import { toJsonbText } from '../store.js';

// TASK-1059 review: Postgres jsonb refuses U+0000 and lone surrogates, so the
// display log's serializer swaps them for U+FFFD. The real-Postgres round trip
// is in display-events.test.ts; this pins the serializer's exact output.
describe('toJsonbText', () => {
  it('is JSON.stringify for ordinary values', () => {
    const v = { a: 'x', b: [1, 'y', null, true], c: { d: 'z' }, e: '😀' };
    expect(toJsonbText(v)).toBe(JSON.stringify(v));
  });

  it('replaces U+0000 and lone surrogates in string values', () => {
    expect(JSON.parse(toJsonbText({ t: 'a\u0000b\ud800c\udc00d\udc00\ud800e' }))).toEqual({
      t: 'a�b�c�d��e',
    });
  });

  it('replaces them in object keys too, nested and in arrays', () => {
    expect(JSON.parse(toJsonbText([{ 'k\u0000': { 'x\ud800': 'v' } }]))).toEqual([
      { 'k�': { 'x�': 'v' } },
    ]);
  });

  it('keeps a well-formed surrogate pair', () => {
    expect(JSON.parse(toJsonbText('😀'))).toBe('😀');
  });
});
