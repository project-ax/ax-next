import { describe, expect, it } from 'vitest';
import { HookBus, PluginError } from '@ax/core';
import { createEmbeddingsPlugin } from '../plugin.js';

describe('@ax/embeddings plugin manifest', () => {
  it('registers exactly the two hook names @ax/memory-facts-sqlite calls', async () => {
    // These two literals are a contract with @ax/memory-facts-sqlite, which
    // cannot import them (Invariant 2) and therefore spells them out itself —
    // see `packages/memory-facts-sqlite/src/__tests__/hash-embedder.ts:42-43`.
    // A rename on either side is a silent outage: the consumer's
    // `bus.hasService(ref.hook)` just goes false and recall reports
    // `degraded: ['semantic', 'ranking']` forever. So assert the STRINGS, not
    // the exported constants — an assertion against `EMBED_HOOK` would follow
    // a rename straight over the cliff.
    const plugin = createEmbeddingsPlugin();
    expect(plugin.manifest.registers).toEqual(['embeddings:embed', 'embeddings:rerank']);
  });

  it('declares no optionalCalls KEY at all in local-only mode', () => {
    // Negative space on purpose: `manifest.optionalCalls` being `undefined`
    // is what a `{ optionalCalls: undefined }` spread produces too, and that
    // is NOT the same manifest once it crosses a zod parse or a `toEqual`.
    // T2 adds the key conditionally; in T1 it must be absent.
    const plugin = createEmbeddingsPlugin();
    expect('optionalCalls' in plugin.manifest).toBe(false);
  });

  it('declares no calls and no subscribes', () => {
    const plugin = createEmbeddingsPlugin();
    expect(plugin.manifest.calls).toEqual([]);
    expect(plugin.manifest.subscribes).toEqual([]);
    expect(plugin.manifest.name).toBe('@ax/embeddings');
  });

  it('registers both services on the bus at init', async () => {
    const bus = new HookBus();
    expect(bus.hasService('embeddings:embed')).toBe(false);
    expect(bus.hasService('embeddings:rerank')).toBe(false);

    await createEmbeddingsPlugin().init({ bus, config: {} });

    expect(bus.hasService('embeddings:embed')).toBe(true);
    expect(bus.hasService('embeddings:rerank')).toBe(true);
  });
});

describe('@ax/embeddings dimensions config', () => {
  // Fail fast at CONSTRUCTION, not at the first embed: a deployment that
  // typo'd its vector width should not boot and then write garbage into a
  // fixed-width column.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['over the ceiling', 4097],
  ])('throws invalid-config for a %s dimensions', (_label, dimensions) => {
    expect(() => createEmbeddingsPlugin({ dimensions })).toThrow(PluginError);
    try {
      createEmbeddingsPlugin({ dimensions });
      expect.unreachable('createEmbeddingsPlugin should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).code).toBe('invalid-config');
      expect((err as PluginError).plugin).toBe('@ax/embeddings');
    }
  });

  it('accepts an omitted dimensions and the ceiling itself', () => {
    expect(() => createEmbeddingsPlugin()).not.toThrow();
    expect(() => createEmbeddingsPlugin({})).not.toThrow();
    expect(() => createEmbeddingsPlugin({ dimensions: 4096 })).not.toThrow();
    expect(() => createEmbeddingsPlugin({ dimensions: 1 })).not.toThrow();
  });
});
