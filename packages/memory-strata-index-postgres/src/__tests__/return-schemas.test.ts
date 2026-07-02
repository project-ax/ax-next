import { describe, it, expect } from 'vitest';
import type { SearchOutput, SearchResult } from '@ax/memory-strata-index-contract';
import { SearchOutputSchema } from '../plugin.js';

// ARCH-13 drift guard for `memory:index:search` (postgres peer — structurally
// identical to the sqlite backend, the I2 two-backend pattern).

const result: SearchResult = {
  docId: 'preference/react',
  category: 'preference',
  slug: 'react',
  summary: 'User prefers React',
  snippet: 'some excerpt',
  score: 0.87,
};

describe('memory-strata-index-postgres return schemas', () => {
  it('memory:index:search round-trips a fully-populated SearchOutput', () => {
    const full: SearchOutput = { results: [result] };
    const parsed = SearchOutputSchema.parse(full);
    expect(parsed).toEqual(full);
    expect(parsed.results[0]!.snippet).toBe('some excerpt');
  });

  it('accepts an empty results array', () => {
    expect(SearchOutputSchema.parse({ results: [] })).toEqual({ results: [] });
  });

  it('rejects a non-number score', () => {
    expect(SearchOutputSchema.safeParse({ results: [{ ...result, score: 'high' }] }).success).toBe(
      false,
    );
  });

  it('rejects a missing docId', () => {
    const { docId: _omit, ...rest } = result;
    expect(SearchOutputSchema.safeParse({ results: [rest] }).success).toBe(false);
  });
});
