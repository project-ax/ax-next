import { describe, expect, it } from 'vitest';
import { slugify } from '../slugify.js';

describe('slugify', () => {
  it('lowercases and dasherizes', () => {
    expect(slugify('React')).toBe('react');
    expect(slugify('Project Alpha')).toBe('project-alpha');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(slugify('foo/bar baz')).toBe('foo-bar-baz');
    expect(slugify('  spaces  ')).toBe('spaces');
  });

  it('refuses path traversal', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
  });

  it('falls back to "general" on empty input', () => {
    expect(slugify('')).toBe('general');
    expect(slugify('   ')).toBe('general');
    expect(slugify('---')).toBe('general');
  });
});
