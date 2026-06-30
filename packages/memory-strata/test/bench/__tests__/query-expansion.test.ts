import { describe, it, expect } from 'vitest';
import {
  expandQuery,
  prfTerms,
  discoverEntities,
  DEFAULT_STOPWORDS,
} from '../query-expansion.js';

describe('discoverEntities', () => {
  it('lifts capitalized multi-word spans', () => {
    expect(discoverEntities('what did I say about San Francisco trips')).toContain(
      'San Francisco',
    );
  });

  it('keeps quoted phrases verbatim', () => {
    const ents = discoverEntities('did I mention "the blue jacket" recently');
    expect(ents).toContain('the blue jacket');
  });

  it('keeps a standalone proper noun that is NOT query-initial', () => {
    const ents = discoverEntities('when did I visit Patagonia');
    expect(ents).toContain('Patagonia');
  });

  it('does NOT treat the query-initial capitalized word as an entity', () => {
    // "What" is capitalized by grammar, not because it is a proper noun.
    const ents = discoverEntities('What is the cortado recipe');
    expect(ents).not.toContain('What');
  });

  it('dedupes repeated entities (case-insensitive)', () => {
    const ents = discoverEntities('about San Francisco and san Francisco again Paris Paris');
    // "Paris Paris" is one multi-word span; ensure no duplicate bare "Paris" too.
    const parisCount = ents.filter((e) => e.toLowerCase().includes('paris')).length;
    expect(parisCount).toBe(1);
  });
});

describe('prfTerms', () => {
  const hits = [
    { body: 'The cortado is espresso cut with warm milk, a Spanish coffee tradition.' },
    { body: 'I ordered a cortado at the espresso bar; the milk was steamed perfectly.' },
  ];

  it('harvests the most frequent content terms from hit bodies', () => {
    const terms = prfTerms('what coffee did I order', hits, { prfTermCount: 5 });
    // "espresso" and "milk" appear twice across bodies; "coffee" is in the query → excluded.
    expect(terms).toContain('espresso');
    expect(terms).toContain('milk');
    expect(terms).not.toContain('coffee');
  });

  it('drops stopwords', () => {
    const terms = prfTerms('order', hits, { prfTermCount: 20 });
    for (const s of ['the', 'is', 'with', 'a']) expect(terms).not.toContain(s);
  });

  it('drops terms already present in the query', () => {
    const terms = prfTerms('cortado espresso', hits, { prfTermCount: 20 });
    expect(terms).not.toContain('cortado');
    expect(terms).not.toContain('espresso');
  });

  it('drops pure numbers and sub-minLength tokens', () => {
    const numHits = [{ body: 'meeting at 2024 on 5 with Bob xy zz' }];
    const terms = prfTerms('meeting', numHits, { prfTermCount: 20, minTermLength: 3 });
    expect(terms).not.toContain('2024');
    expect(terms).not.toContain('xy'); // length 2 < minLength 3
    expect(terms).toContain('bob');
  });

  it('returns an empty list when there are no hits', () => {
    expect(prfTerms('anything', [])).toEqual([]);
  });

  it('is deterministic: ties break alphabetically', () => {
    const tieHits = [{ body: 'zebra apple zebra apple mango mango' }];
    const terms = prfTerms('fruit', tieHits, { prfTermCount: 3 });
    // all three appear twice → alphabetical order
    expect(terms).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('expandQuery', () => {
  it('appends entities and PRF terms to the original query', () => {
    const hits = [{ body: 'espresso espresso milk steamed' }];
    const out = expandQuery('what did I order at Blue Bottle', hits, { prfTermCount: 3 });
    expect(out.startsWith('what did I order at Blue Bottle')).toBe(true);
    expect(out).toContain('Blue Bottle'); // entity repeated
    expect(out).toContain('espresso'); // PRF term
  });

  it('returns the original query unchanged with no hits and no entities', () => {
    expect(expandQuery('what is the time', [])).toBe('what is the time');
  });

  it('does not crash on empty query', () => {
    expect(expandQuery('', [{ body: 'some body text here please' }])).toContain('body');
  });
});

describe('DEFAULT_STOPWORDS', () => {
  it('covers the LongMemEval markdown role headers (user/assistant)', () => {
    // doc bodies are "## user\n…\n## assistant\n…" — these would otherwise top the PRF ranking.
    expect(DEFAULT_STOPWORDS.has('user')).toBe(true);
    expect(DEFAULT_STOPWORDS.has('assistant')).toBe(true);
  });
});
