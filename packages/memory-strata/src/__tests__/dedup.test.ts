import { describe, expect, it } from 'vitest';
import { isDupe, jaccard, tokenize } from '../dedup.js';

describe('tokenize', () => {
  it('lowercases and extracts content tokens', () => {
    const tokens = tokenize('User prefers React');
    expect(tokens).toContain('user');
    expect(tokens).toContain('prefers');
    expect(tokens).toContain('react');
  });

  it('strips stopwords', () => {
    const tokens = tokenize('the user is on a team');
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('is')).toBe(false);
    expect(tokens.has('a')).toBe(false);
    expect(tokens.has('on')).toBe(false);
    expect(tokens).toContain('user');
    expect(tokens).toContain('team');
  });
});

describe('jaccard', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['user', 'prefers', 'react']);
    expect(jaccard(a, a)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['user', 'prefers', 'react']);
    const b = new Set(['project', 'ships', 'friday']);
    expect(jaccard(a, b)).toBe(0);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe('isDupe', () => {
  it('case-insensitive: "User prefers React" vs "user prefers react" -> similarity 1.0 (dupe)', () => {
    expect(isDupe('User prefers React', ['user prefers react'])).toBe(true);
  });

  it('partial overlap (jaccard = 0.5) is dupe above 0.4 threshold', () => {
    // jaccard = {user, prefers} ∩ / {user, prefers, react, vue} ∪ = 2/4 = 0.5. Plan's ~0.66 figure assumed 'user' was a stopword; it isn't. Tested at threshold 0.4.
    expect(isDupe('User prefers React', ['User prefers Vue'], { threshold: 0.4 })).toBe(true);
  });

  it('partial overlap (jaccard = 0.5) is NOT a dupe at default 0.6 threshold', () => {
    expect(isDupe('User prefers React', ['User prefers Vue'])).toBe(false);
  });

  it('"User prefers React" vs "Project ships Friday" -> ~0.0 (not a dupe)', () => {
    expect(isDupe('User prefers React', ['Project ships Friday'])).toBe(false);
  });

  it('uses default threshold 0.6', () => {
    // Same text, different casing -> jaccard 1.0 -> dupe at any threshold
    expect(isDupe('User prefers React', ['user prefers react'])).toBe(true);
    // Completely different -> not dupe
    expect(isDupe('User prefers React', ['Project ships Friday'])).toBe(false);
  });

  it('returns false when existing list is empty', () => {
    expect(isDupe('User prefers React', [])).toBe(false);
  });

  it('matches against any entry in the existing list', () => {
    const existing = ['Project ships Friday', 'user prefers react'];
    expect(isDupe('User prefers React', existing)).toBe(true);
  });
});
