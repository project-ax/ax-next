import { describe, expect, it } from 'vitest';
import type { RerankInput, RerankOutput } from '../wire.js';
import { busWithPlugin, ctx } from './harness.js';

async function rerank(input: RerankInput): Promise<RerankOutput> {
  const bus = await busWithPlugin();
  return bus.call<RerankInput, RerankOutput>('embeddings:rerank', ctx, input);
}

describe('embeddings:rerank — local mode', () => {
  it('returns one score per document, in input order', async () => {
    const { scores } = await rerank({
      query: 'alpha beta',
      documents: ['alpha beta', 'nothing here', 'alpha'],
    });
    expect(scores).toHaveLength(3);
    // Positional, and the three values differ — an implementation that
    // returned the scores sorted, or all-equal, fails here.
    expect(scores).toEqual([1, 0, 0.5]);
  });

  it('scores a document containing every query token above one containing none', async () => {
    const { scores } = await rerank({
      query: 'deploy the canary',
      documents: ['we deploy the canary nightly', 'unrelated prose about bread'],
    });
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
  });

  it('scores exactly overlap / |query tokens|', async () => {
    // Query tokens: {sqlite, vector, index} → 3 distinct.
    // Document matches `sqlite` and `index`, not `vector` → 2/3.
    const { scores } = await rerank({
      query: 'sqlite vector index',
      documents: ['the sqlite index is rebuilt on boot'],
    });
    expect(scores[0]).toBeCloseTo(2 / 3, 12);
  });

  it('counts DISTINCT query tokens, so a repeated token does not inflate the denominator', async () => {
    // 'alpha alpha beta' is 2 distinct tokens; a document matching only
    // `alpha` scores 1/2, not 1/3.
    const { scores } = await rerank({
      query: 'alpha alpha beta',
      documents: ['alpha only'],
    });
    expect(scores[0]).toBeCloseTo(0.5, 12);
  });

  it('returns all-zero scores for a query with no word tokens', async () => {
    // Zero query tokens means a 0/0 denominator. `dem-memory`'s
    // `lexicalReranker` answers 0 for every document rather than NaN, and a
    // NaN would poison the consumer's finite-number check and degrade the
    // whole ranking channel.
    const { scores } = await rerank({ query: '!!! ???', documents: ['alpha', 'beta'] });
    expect(scores).toEqual([0, 0]);
  });

  it('accepts an empty documents array and returns no scores', async () => {
    await expect(rerank({ query: 'anything', documents: [] })).resolves.toEqual({ scores: [] });
  });

  it('is case- and punctuation-insensitive the same way the embedder is', async () => {
    const { scores } = await rerank({
      query: 'Alpha, Beta!',
      documents: ['ALPHA -- beta'],
    });
    expect(scores[0]).toBeCloseTo(1, 12);
  });
});
