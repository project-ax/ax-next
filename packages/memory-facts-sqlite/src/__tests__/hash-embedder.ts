// A deterministic, network-free embedder for the sqlite suite — ported from
// `dem-memory/src/models/embeddings.ts`'s `hashEmbedder`.
//
// It is a real embedder in every way the store cares about: 384 finite floats,
// L2-normalized, stable across runs and processes, and similarity that tracks
// token overlap. That is enough to exercise the `vec0` write, the `MATCH ... k`
// read, the over-fetch-then-filter step and the `'semantic'` flag FOR REAL,
// with no provider, no credential and no egress.
//
// It is deliberately NOT registered by `contract.test.ts`'s factory: contract
// cases 7 and 8 assert the no-producer degraded state, and an embedder quietly
// present there would make both of them pass for the wrong reason.

import type { HookBus } from '@ax/core';
import { EMBEDDING_DIMENSIONS } from '../schema.js';
import type { EmbedInput, EmbedOutput } from '../producers.js';

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Signed-bucket hashing over word tokens, then L2-normalize. */
export function hashVector(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const buckets = new Map<number, number>();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    const sign = hash >>> 31 === 1 ? -1 : 1;
    buckets.set(index, (buckets.get(index) ?? 0) + sign);
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const [index, value] of buckets) vector[index] = value;
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export const EMBED_HOOK = 'embeddings:embed';
export const RERANK_HOOK = 'embeddings:rerank';

/** Register the hash embedder at {@link EMBED_HOOK}. Records every call, for assertions. */
export function registerHashEmbedder(bus: HookBus): { calls: EmbedInput[] } {
  const calls: EmbedInput[] = [];
  bus.registerService<EmbedInput, EmbedOutput>(
    EMBED_HOOK,
    'test:hash-embedder',
    async (_ctx, input) => {
      calls.push(input);
      return { vectors: input.texts.map((text) => hashVector(text)) };
    },
  );
  return { calls };
}
