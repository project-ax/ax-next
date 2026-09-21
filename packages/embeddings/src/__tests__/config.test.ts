// Remote config is validated at CONSTRUCTION, and mode is PER HOOK.
//
// Both claims are about boot, not about a request: a deployment that typo'd
// its project id should fail to start, and a deployment that configured a
// remote reranker but no remote embedder should still embed — locally, with
// no network — rather than quietly half-degrading.

import { describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import {
  createEmbeddingsPlugin,
  type EmbeddingsConfig,
  type RemoteEmbedConfig,
  type RemoteRerankConfig,
} from '../plugin.js';
import { busWithPlugin, ctx, fetchStub, jsonResponse } from './harness.js';
import type { EmbedInput, EmbedOutput, RerankInput, RerankOutput } from '../wire.js';

const GOOD_EMBED = {
  provider: 'vertex' as const,
  credentialRef: 'provider:vertex',
  projectId: 'ax-next-dev',
};
const GOOD_RERANK = { provider: 'cohere' as const, credentialRef: 'provider:cohere' };

/** Build a config whose remote section is deliberately wrong in one way. */
function withEmbed(patch: Record<string, unknown>): EmbeddingsConfig {
  return { embed: { ...GOOD_EMBED, ...patch } as unknown as RemoteEmbedConfig };
}
function withRerank(patch: Record<string, unknown>): EmbeddingsConfig {
  return { rerank: { ...GOOD_RERANK, ...patch } as unknown as RemoteRerankConfig };
}

function expectInvalidConfig(make: () => unknown): void {
  try {
    make();
    expect.unreachable('createEmbeddingsPlugin should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('invalid-config');
    expect((err as PluginError).plugin).toBe('@ax/embeddings');
  }
}

describe('remote config is rejected at construction', () => {
  it.each([
    ['an unknown embed provider', withEmbed({ provider: 'openai' })],
    // `constructor` and `__proto__` resolve THROUGH Object.prototype to a
    // truthy non-endpoint under a plain property lookup. With the own-property
    // guard they are just unknown ids; without it, they boot.
    ['an embed provider of constructor', withEmbed({ provider: 'constructor' })],
    ['an embed provider of __proto__', withEmbed({ provider: '__proto__' })],
    ['an empty embed credentialRef', withEmbed({ credentialRef: '' })],
    ['a missing embed credentialRef', withEmbed({ credentialRef: undefined })],
    ['an uppercase projectId', withEmbed({ projectId: 'AX-Next-Dev' })],
    ['a path-traversing projectId', withEmbed({ projectId: '../../../etc' })],
    ['a too-short projectId', withEmbed({ projectId: 'abcd' })],
    ['a digit-leading projectId', withEmbed({ projectId: '1ax-next' })],
    ['a missing projectId', withEmbed({ projectId: undefined })],
    ['a path-traversing embed model', withEmbed({ model: '../../../x' })],
    ['an empty embed model', withEmbed({ model: '' })],
    ['an unknown rerank provider', withRerank({ provider: 'openai' })],
    ['an empty rerank credentialRef', withRerank({ credentialRef: '' })],
    ['a path-traversing rerank model', withRerank({ model: 'a/../../b' })],
  ])('throws invalid-config for %s', (_label, config) => {
    expectInvalidConfig(() => createEmbeddingsPlugin(config));
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('throws invalid-config for a %s timeoutMs', (_label, timeoutMs) => {
    expectInvalidConfig(() => createEmbeddingsPlugin({ timeoutMs }));
  });

  it('accepts a well-formed remote config on either hook, or both', () => {
    expect(() => createEmbeddingsPlugin({ embed: GOOD_EMBED })).not.toThrow();
    expect(() => createEmbeddingsPlugin({ rerank: GOOD_RERANK })).not.toThrow();
    expect(() =>
      createEmbeddingsPlugin({
        embed: { ...GOOD_EMBED, model: 'text-embedding-004' },
        rerank: { ...GOOD_RERANK, model: 'rerank-v3.5' },
        timeoutMs: 1,
      }),
    ).not.toThrow();
  });
});

describe('the optionalCalls manifest entry', () => {
  it.each([
    ['embed only', { embed: GOOD_EMBED }],
    ['rerank only', { rerank: GOOD_RERANK }],
    ['both', { embed: GOOD_EMBED, rerank: GOOD_RERANK }],
  ])('declares credentials:get when %s is configured', (_label, config) => {
    const { manifest } = createEmbeddingsPlugin(config);
    expect('optionalCalls' in manifest).toBe(true);
    expect(manifest.optionalCalls?.map((oc) => oc.hook)).toEqual(['credentials:get']);
    expect(manifest.optionalCalls?.[0]?.degradation.length).toBeGreaterThan(0);
    // Still optional, never required: a deployment with no credential store
    // must not fail `verifyCalls` at boot, it must degrade at call time.
    expect(manifest.calls).toEqual([]);
  });

  it('still declares no optionalCalls KEY with neither configured', () => {
    expect('optionalCalls' in createEmbeddingsPlugin().manifest).toBe(false);
    expect('optionalCalls' in createEmbeddingsPlugin({ dimensions: 8 }).manifest).toBe(false);
    expect('optionalCalls' in createEmbeddingsPlugin({ timeoutMs: 99 }).manifest).toBe(false);
  });
});

describe('mode is decided per hook', () => {
  it('answers rerank locally when only embed is remote', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(
      { embed: GOOD_EMBED, fetchImpl: stub.impl },
      { credential: 'token' },
    );

    // Lexical overlap — the local reranker's answer, not a provider's.
    const out = await bus.call<RerankInput, RerankOutput | undefined>('embeddings:rerank', ctx, {
      query: 'alpha beta',
      documents: ['alpha only', 'nothing here'],
    });

    expect(out?.scores).toEqual([0.5, 0]);
    expect(stub.calls).toHaveLength(0);
  });

  it('answers embed locally when only rerank is remote', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(
      { dimensions: 8, rerank: GOOD_RERANK, fetchImpl: stub.impl },
      { credential: 'token' },
    );

    const out = await bus.call<EmbedInput, EmbedOutput | undefined>('embeddings:embed', ctx, {
      texts: ['alpha beta'],
      task: 'document',
    });

    expect(out?.vectors).toHaveLength(1);
    expect(out?.vectors[0]).toHaveLength(8);
    // L2-normalized: the local hash embedder's signature, and nothing a
    // provider stub in this test could have produced.
    expect(Math.hypot(...(out?.vectors[0] ?? []))).toBeCloseTo(1, 10);
    expect(stub.calls).toHaveLength(0);
  });
});
