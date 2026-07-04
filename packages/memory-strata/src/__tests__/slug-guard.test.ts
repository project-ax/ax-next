import { describe, expect, it } from 'vitest';
import { findNearDupSlug } from '../slug-guard.js';

describe('findNearDupSlug', () => {
  it('matches a token-subset slug one token apart', () => {
    expect(findNearDupSlug('b-29-bomber-model', ['b-29-bomber-model-kit'])).toBe(
      'b-29-bomber-model-kit',
    );
    expect(findNearDupSlug('b-29-bomber-model-kit', ['b-29-bomber-model'])).toBe(
      'b-29-bomber-model',
    );
  });
  it('rejects short slugs (guard against catch-all merges)', () => {
    expect(findNearDupSlug('user', ['user-s-watch'])).toBeNull();
  });
  it('rejects slugs more than one token apart', () => {
    expect(findNearDupSlug('b-29-bomber', ['b-29-bomber-model-kit'])).toBeNull();
  });
  it('rejects non-subset overlaps', () => {
    expect(findNearDupSlug('tiger-i-diorama', ['tiger-ii-model-kit'])).toBeNull();
  });
  it('returns null with no candidates', () => {
    expect(findNearDupSlug('anything-at-all-here', [])).toBeNull();
  });
});
