import { describe, expect, it } from 'vitest';
import { validateGeneratedTitle } from '../validate.js';

describe('validateGeneratedTitle', () => {
  it('trims surrounding whitespace', () => {
    expect(validateGeneratedTitle('  Hello World  ')).toBe('Hello World');
  });

  it('strips matched outer double quotes', () => {
    expect(validateGeneratedTitle('"Hello World"')).toBe('Hello World');
  });

  it('strips matched outer single quotes', () => {
    expect(validateGeneratedTitle("'Hello World'")).toBe('Hello World');
  });

  it('returns null when only matched quotes are present (empty after strip)', () => {
    expect(validateGeneratedTitle('""')).toBeNull();
  });

  it('returns null on the empty string', () => {
    expect(validateGeneratedTitle('')).toBeNull();
  });

  it('returns null on the literal "Untitled" sentinel', () => {
    expect(validateGeneratedTitle('Untitled')).toBeNull();
  });

  it('returns null on whitespace-only input', () => {
    expect(validateGeneratedTitle('   ')).toBeNull();
  });

  it('truncates oversize titles to 256 characters', () => {
    const oversized = 'x'.repeat(257);
    const out = validateGeneratedTitle(oversized);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(256);
    expect(out).toBe('x'.repeat(256));
  });

  it('keeps only the first line on multi-line input', () => {
    expect(validateGeneratedTitle('First line\nsecond')).toBe('First line');
  });

  it('does not strip an asymmetric leading quote', () => {
    expect(validateGeneratedTitle('"Hello')).toBe('"Hello');
  });
});
