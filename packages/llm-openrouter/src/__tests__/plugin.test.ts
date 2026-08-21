import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus } from '@ax/core';
import { createLlmOpenRouterPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest + init contract. Mirrors @ax/llm-anthropic's plugin.test.ts — same
// shape of promises: exactly the hooks we say we register, an optionalCalls
// entry only in credentialResolution mode, and a hard refusal to boot with no
// key in static mode.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV_KEY = process.env.OPENROUTER_API_KEY;

/** A fetch that fails loudly — these tests must never reach the network. */
const explodingFetch: typeof fetch = async () => {
  throw new Error('no network calls in the suite');
};

describe('@ax/llm-openrouter plugin manifest', () => {
  it('registers exactly the three OpenRouter service hooks, no calls, no subscribes', () => {
    const plugin = createLlmOpenRouterPlugin({ apiKey: 'test-key' });
    expect(plugin.manifest).toEqual({
      name: '@ax/llm-openrouter',
      version: '0.0.0',
      registers: [
        'llm:call:openrouter',
        'models:list-supported:openrouter',
        'credentials:validate:openrouter',
      ],
      calls: [],
      subscribes: [],
    });
  });

  it('declares credentials:get as an optionalCall only in credentialResolution mode', () => {
    const resolving = createLlmOpenRouterPlugin({ credentialResolution: true });
    expect(resolving.manifest.optionalCalls).toEqual([
      expect.objectContaining({ hook: 'credentials:get' }),
    ]);
    // The degradation string is the operator-facing explanation of what
    // breaks when @ax/credentials isn't loaded; it must name the fallback.
    expect(resolving.manifest.optionalCalls?.[0].degradation).toContain('OPENROUTER_API_KEY');

    const staticMode = createLlmOpenRouterPlugin({ apiKey: 'k' });
    expect(staticMode.manifest.optionalCalls).toBeUndefined();
  });

  it('registers the same three hooks in both modes (manifest matches reality)', async () => {
    for (const plugin of [
      createLlmOpenRouterPlugin({ apiKey: 'k', fetchImpl: explodingFetch }),
      createLlmOpenRouterPlugin({ credentialResolution: true, fetchImpl: explodingFetch }),
    ]) {
      const bus = new HookBus();
      await plugin.init({ bus, config: {} });
      for (const hook of plugin.manifest.registers) {
        expect(bus.hasService(hook)).toBe(true);
      }
    }
  });
});

describe('@ax/llm-openrouter init', () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL_ENV_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIGINAL_ENV_KEY;
  });

  it('throws init-failed when neither cfg.apiKey nor OPENROUTER_API_KEY is set', async () => {
    const plugin = createLlmOpenRouterPlugin();
    const bus = new HookBus();
    await expect(plugin.init({ bus, config: {} })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'init-failed',
      plugin: '@ax/llm-openrouter',
      hookName: 'init',
    });
  });

  it('throws init-failed when cfg.apiKey is the empty string', async () => {
    const plugin = createLlmOpenRouterPlugin({ apiKey: '' });
    const bus = new HookBus();
    await expect(plugin.init({ bus, config: {} })).rejects.toMatchObject({
      code: 'init-failed',
    });
  });

  it('boots off OPENROUTER_API_KEY when cfg.apiKey is unset', async () => {
    process.env.OPENROUTER_API_KEY = 'env-key';
    const plugin = createLlmOpenRouterPlugin({ fetchImpl: explodingFetch });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    expect(bus.hasService('llm:call:openrouter')).toBe(true);
  });

  it('init does NOT throw without a static key in credentialResolution mode', async () => {
    const plugin = createLlmOpenRouterPlugin({
      credentialResolution: true,
      fetchImpl: explodingFetch,
    });
    const bus = new HookBus();
    await expect(plugin.init({ bus, config: {} })).resolves.toBeUndefined();
    expect(bus.hasService('llm:call:openrouter')).toBe(true);
  });
});
