import { describe, expect, it } from 'vitest';
import type { EmbedInput, EmbedOutput } from '../wire.js';
import { busWithPlugin, ctx, dot, l2 } from './harness.js';

const DEFAULT_DIMENSIONS = 384;

async function embed(
  input: EmbedInput,
  config?: { dimensions?: number },
): Promise<EmbedOutput> {
  const bus = await busWithPlugin(config);
  return bus.call<EmbedInput, EmbedOutput>('embeddings:embed', ctx, input);
}

describe('embeddings:embed — local mode', () => {
  it('returns one vector per input text, in input order', async () => {
    const texts = ['alpha beta', 'gamma', 'delta epsilon zeta'];
    const { vectors } = await embed({ texts, task: 'document' });

    expect(vectors).toHaveLength(3);
    // Order is positional, so prove it by re-embedding each text on its own
    // and matching the slot it landed in.
    for (const [i, text] of texts.entries()) {
      const solo = await embed({ texts: [text], task: 'document' });
      expect(vectors[i]).toEqual(solo.vectors[0]);
    }
  });

  it('every vector is exactly `dimensions` finite numbers', async () => {
    const { vectors } = await embed({
      texts: ['hello world', '', '!!! ???', 'ünïcödé 123'],
      task: 'query',
    });
    for (const vector of vectors) {
      expect(vector).toHaveLength(DEFAULT_DIMENSIONS);
      expect(vector.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
    }
  });

  it('L2-normalizes a text that has tokens', async () => {
    const { vectors } = await embed({ texts: ['the quick brown fox'], task: 'document' });
    expect(l2(vectors[0] ?? [])).toBeCloseTo(1, 9);
  });

  it('returns an all-zero vector for a text with no word tokens', async () => {
    // No `[\p{L}\p{N}]+` match anywhere, so there is nothing to normalize and
    // dividing by a zero norm would be `NaN` — the store would then write 384
    // NaNs into a vec0 column and compare distances against them forever.
    const { vectors } = await embed({ texts: ['!!! ??? ---'], task: 'document' });
    expect(vectors[0]).toHaveLength(DEFAULT_DIMENSIONS);
    expect(vectors[0]?.every((v) => v === 0)).toBe(true);
  });

  it('is deterministic across two separate plugin instances', async () => {
    // Two instances, two buses — the same process, but nothing shared between
    // them. A cached-per-instance or `Math.random`-seeded embedder passes the
    // single-instance tests above and fails here.
    const a = await embed({ texts: ['stable text'], task: 'document' });
    const b = await embed({ texts: ['stable text'], task: 'document' });
    expect(a.vectors[0]).toEqual(b.vectors[0]);
  });

  it('scores a token-sharing text above an unrelated one', async () => {
    const { vectors } = await embed({
      texts: ['kubernetes cluster autoscaler', 'kubernetes cluster ingress', 'banana bread recipe'],
      task: 'document',
    });
    const [anchor, related, unrelated] = vectors as [number[], number[], number[]];
    expect(dot(anchor, related)).toBeGreaterThan(dot(anchor, unrelated));
  });

  it('honours a configured dimensions of 128', async () => {
    const { vectors } = await embed({ texts: ['alpha beta gamma'], task: 'document' }, { dimensions: 128 });
    expect(vectors[0]).toHaveLength(128);
    expect(l2(vectors[0] ?? [])).toBeCloseTo(1, 9);
  });

  it('accepts an empty texts array and returns no vectors', async () => {
    // Legal, not an error. The in-repo consumer short-circuits before calling
    // (`producers.ts` `embedTexts` returns `[]` for an empty input), but a
    // caller that does not must get `{ vectors: [] }` rather than a throw.
    await expect(embed({ texts: [], task: 'document' })).resolves.toEqual({ vectors: [] });
  });

  it('accepts task: query and an explicit model without changing the local result', async () => {
    // `model` is producer-native and a local embedder has no models — but the
    // field is part of the wire shape, so it must be accepted, not rejected.
    const withModel = await embed({ texts: ['same text'], task: 'query', model: 'whatever-v1' });
    const withoutModel = await embed({ texts: ['same text'], task: 'query' });
    expect(withModel.vectors[0]).toEqual(withoutModel.vectors[0]);
  });
});
