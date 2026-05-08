import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type Anthropic from '@anthropic-ai/sdk';
import { createLlmAnthropicPlugin, type ModelsListSupportedOutput } from '../plugin.js';

// ---------------------------------------------------------------------------
// models:list-supported service hook — Task 2.7 Step 1b
//
// Boots the plugin with a mock clientFactory (llm-anthropic still requires
// a valid apiKey at init time) and calls models:list-supported directly.
// ---------------------------------------------------------------------------

function makeStubClient(): Anthropic {
  return {
    messages: {
      create: async () => {
        throw new Error('not expected in this test');
      },
    },
  } as unknown as Anthropic;
}

describe('@ax/llm-anthropic models:list-supported', () => {
  it('registers the service and returns a non-empty list', async () => {
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      clientFactory: () => makeStubClient(),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });

    expect(bus.hasService('models:list-supported')).toBe(true);

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const out = await bus.call<unknown, ModelsListSupportedOutput>(
      'models:list-supported',
      ctx,
      {},
    );

    expect(out.models.length).toBeGreaterThan(0);
    expect(out.models.some((m) => m.kind === 'fast')).toBe(true);
    expect(out.models.some((m) => m.kind === 'default' || m.kind === 'either')).toBe(true);
    expect(out.models[0].id).toMatch(/^claude-/);
  });

  it('each model has id, label, and a valid kind', async () => {
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      clientFactory: () => makeStubClient(),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const out = await bus.call<unknown, ModelsListSupportedOutput>(
      'models:list-supported',
      ctx,
      {},
    );

    const validKinds = new Set(['fast', 'default', 'either']);
    for (const m of out.models) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
      expect(validKinds.has(m.kind)).toBe(true);
    }
  });

  it('manifest declares models:list-supported in registers', () => {
    const plugin = createLlmAnthropicPlugin({ apiKey: 'test-key' });
    expect(plugin.manifest.registers).toContain('models:list-supported');
  });
});
