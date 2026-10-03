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
    const out = fenceBlock('a‮b​c d\u0007e﻿f', 100, 10)!;
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
    const out = fenceBlock('abcd‮', 6, 10)!;
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

  it('exactly at the cap is not truncated', () => {
    expect(fenceBlock('x'.repeat(10), 10, 1)).toEqual({ text: 'x'.repeat(10), truncated: false });
  });

  it('answers null for nothing legible', () => {
    expect(fenceBlock(undefined, 10, 10)).toBeNull();
    expect(fenceBlock(null, 10, 10)).toBeNull();
    expect(fenceBlock('  \n \r\n', 10, 10)).toBeNull();
  });
});
