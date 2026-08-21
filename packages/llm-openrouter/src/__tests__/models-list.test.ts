import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, parseModelRef } from '@ax/core';
import {
  createLlmOpenRouterPlugin,
  ModelsListSupportedOutputSchema,
  type ModelsListSupportedOutput,
} from '../plugin.js';

// ---------------------------------------------------------------------------
// models:list-supported:openrouter — the seed catalog.
//
// The catalog is a LABEL SOURCE, not a gate (see plugin.ts). What these tests
// actually protect is the *ref shape*: every id has to survive parseModelRef
// with provider `openrouter` and its nested vendor slug intact, because that's
// the coordinate the picker stores and the allow-list matches on. A bare id or
// a slug chopped at the second slash would route nowhere.
// ---------------------------------------------------------------------------

const explodingFetch: typeof fetch = async () => {
  throw new Error('no network calls in the suite');
};

async function catalog(): Promise<ModelsListSupportedOutput> {
  const plugin = createLlmOpenRouterPlugin({ apiKey: 'test-key', fetchImpl: explodingFetch });
  const bus = new HookBus();
  await plugin.init({ bus, config: {} });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  return await bus.call<unknown, ModelsListSupportedOutput>(
    'models:list-supported:openrouter',
    ctx,
    {},
  );
}

describe('@ax/llm-openrouter models:list-supported:openrouter', () => {
  it('registers the service and returns a non-empty list', async () => {
    const out = await catalog();
    expect(out.models.length).toBeGreaterThan(0);
  });

  it('every id parses as an openrouter ref with the vendor slug intact', async () => {
    const out = await catalog();
    for (const m of out.models) {
      const parsed = parseModelRef(m.id);
      expect(parsed.provider).toBe('openrouter');
      // The vendor slug carries its own `/` — parseModelRef splits on the
      // FIRST slash, so `openrouter/x-ai/grok-4.6` must keep `x-ai/` in the
      // model id rather than losing it.
      expect(parsed.modelId).toBe(m.id.slice('openrouter/'.length));
      expect(parsed.modelId).toContain('/');
    }
  });

  it('keeps the nested vendor slug on the flagship refs the PR gate names', async () => {
    const out = await catalog();
    const ids = out.models.map((m) => m.id);
    expect(ids).toContain('openrouter/x-ai/grok-4.6');
    expect(ids).toContain('openrouter/moonshotai/kimi-k3');
    expect(parseModelRef('openrouter/x-ai/grok-4.6')).toEqual({
      provider: 'openrouter',
      modelId: 'x-ai/grok-4.6',
    });
  });

  it('validates against the locally-declared returns schema', async () => {
    const out = await catalog();
    expect(ModelsListSupportedOutputSchema.parse(out)).toEqual(out);
  });

  it('offers at least one fast and one chat-capable model, each with a readable label', async () => {
    const out = await catalog();
    expect(out.models.some((m) => m.kind === 'fast')).toBe(true);
    expect(out.models.some((m) => m.kind === 'default' || m.kind === 'either')).toBe(true);
    for (const m of out.models) {
      expect(m.label.length).toBeGreaterThan(0);
      // A label that's just the ref back again would defeat the point — the
      // picker route already falls back to the bare id for uncovered refs.
      expect(m.label).not.toBe(m.id);
    }
  });

  it('has no duplicate ids', async () => {
    const out = await catalog();
    expect(new Set(out.models.map((m) => m.id)).size).toBe(out.models.length);
  });
});
