import { describe, expect, it } from 'vitest';
import { parseDocId } from '../doc-id.js';

describe('parseDocId', () => {
  it('accepts a valid category/slug docId', () => {
    expect(parseDocId('preference/react')).toEqual({
      category: 'preference',
      slug: 'react',
    });
  });

  it('rejects an empty string', () => {
    expect(parseDocId('')).toBeNull();
  });

  it('rejects a docId containing ..', () => {
    expect(parseDocId('preference/../etc')).toBeNull();
  });

  it('rejects a docId with no slash', () => {
    expect(parseDocId('foo')).toBeNull();
  });

  it('rejects a docId with multiple slashes', () => {
    expect(parseDocId('a/b/c')).toBeNull();
  });

  it('rejects a leading slash (empty category)', () => {
    expect(parseDocId('/x')).toBeNull();
  });

  it('rejects a trailing slash (empty slug)', () => {
    expect(parseDocId('x/')).toBeNull();
  });

  it('rejects an unknown category', () => {
    expect(parseDocId('bogus/react')).toBeNull();
  });

  it('rejects a slug with an uppercase letter', () => {
    expect(parseDocId('preference/React')).toBeNull();
  });

  it('rejects a slug containing a space', () => {
    expect(parseDocId('preference/a b')).toBeNull();
  });
});
