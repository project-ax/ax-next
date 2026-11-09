import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX_CHARS, validateSummary } from '../validate.js';

describe('validateSummary', () => {
  it('keeps the first non-empty line, unquoted and unbulleted', () => {
    expect(validateSummary('\n"Planning an animated SVG."\nmore')).toBe('Planning an animated SVG.');
    expect(validateSummary('- Checking the legs.')).toBe('Checking the legs.');
  });

  it('refuses nothing-answers', () => {
    expect(validateSummary('')).toBeNull();
    expect(validateSummary('  ')).toBeNull();
    expect(validateSummary('none')).toBeNull();
  });

  it('strips control characters and caps the length at a word', () => {
    expect(validateSummary('Checking\u0007 the​ legs.')).toBe('Checking the legs.');
    const long = validateSummary('Planning '.repeat(40))!;
    expect([...long].length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});
