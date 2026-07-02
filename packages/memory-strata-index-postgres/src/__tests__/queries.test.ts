import { describe, it, expect } from 'vitest';
import { buildOrTsQuery } from '../queries.js';

// ---------------------------------------------------------------------------
// buildOrTsQuery — pure, container-free unit tests
// ---------------------------------------------------------------------------
// Mirrors sqlite's escapeFts5Query tests. buildOrTsQuery double-quotes each
// token and OR-joins them so websearch_to_tsquery's operators (`-`, `OR`, `"`)
// are neutralized. websearch_to_tsquery never throws on malformed input, so the
// contract here is "the produced string is operator-safe", proven per-token.

describe('buildOrTsQuery', () => {
  it('wraps a single token in double-quotes', () => {
    expect(buildOrTsQuery('react')).toBe('"react"');
  });

  it('quotes each token separately and joins with OR', () => {
    expect(buildOrTsQuery('degree graduated')).toBe('"degree" OR "graduated"');
    expect(buildOrTsQuery('TypeScript language')).toBe('"TypeScript" OR "language"');
  });

  it('quotes a "-"-prefixed token so it is a literal term, not a NOT operator', () => {
    // Unquoted, websearch_to_tsquery would read `-graduated` as `!graduated`
    // (NOT), inverting the match. Quoted, the `-` is literal text inside a
    // phrase. (Contract Test 8c is the end-to-end guard; this pins the string.)
    expect(buildOrTsQuery('-graduated')).toBe('"-graduated"');
    expect(buildOrTsQuery('zzq -graduated')).toBe('"zzq" OR "-graduated"');
  });

  it('neutralizes an embedded double-quote by replacing it with a space', () => {
    // An embedded `"` would close the quote early; replaced with a space the
    // residue parses as an operator-free adjacent phrase.
    expect(buildOrTsQuery('he said "hi"')).toBe('"he" OR "said" OR " hi "');
  });

  it('handles a quote-only token without producing a bare operator', () => {
    // A lone `"` becomes a quoted single space — websearch_to_tsquery treats it
    // as an empty/stop-word query (NOTICE, never an error) that matches nothing.
    // Regression guard: the token must stay wrapped, never leak as a raw `"`.
    expect(buildOrTsQuery('"')).toBe('" "');
    expect(buildOrTsQuery('""')).toBe('"  "');
  });

  it('collapses to empty string for empty / whitespace-only input', () => {
    expect(buildOrTsQuery('')).toBe('');
    expect(buildOrTsQuery('   ')).toBe('');
  });
});
