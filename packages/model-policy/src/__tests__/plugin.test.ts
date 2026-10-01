import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createModelPolicyPlugin } from '../plugin.js';
import { serializeStored } from '../policy.js';
import { POLICY_STORAGE_KEY } from '../shared.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

function bootBus(storage = new Map<string, Uint8Array>()) {
  const bus = new HookBus();
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>('storage:get', 'test', async (_c, i) => ({
    value: storage.get(i.key),
  }));
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>('storage:set', 'test', async (_c, i) => {
    storage.set(i.key, i.value);
    return {};
  });
  return { bus, storage };
}

describe('createModelPolicyPlugin', () => {
  it('declares the documented surface', () => {
    const plugin = createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET] });
    expect(plugin.manifest.name).toBe('@ax/model-policy');
    expect(plugin.manifest.registers).toEqual(['models:get-policy']);
    expect(plugin.manifest.calls).toEqual(['storage:get', 'storage:set']);
  });

  it('refuses an empty or malformed built-in list at construction', () => {
    expect(() => createModelPolicyPlugin({ builtinAllowed: [] })).toThrow(/builtinAllowed is invalid/);
    expect(() => createModelPolicyPlugin({ builtinAllowed: ['bare-id'] })).toThrow(/builtinAllowed is invalid/);
  });

  it('serves the built-in policy through models:get-policy, preferring Claude Sonnet as Default', async () => {
    const { bus } = bootBus();
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET] }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:get-policy', ctx, {})).toEqual({
      allowed: [OPUS, SONNET],
      default: SONNET,
      source: 'builtin',
      version: 0,
    });
  });

  it('honours builtinDefault', async () => {
    const { bus } = bootBus();
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET], builtinDefault: OPUS }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:get-policy', ctx, {})).toMatchObject({ default: OPUS });
  });

  it('serves a saved policy', async () => {
    const storage = new Map<string, Uint8Array>();
    storage.set(
      POLICY_STORAGE_KEY,
      serializeStored({ version: 2, allowed: [OPUS], default: OPUS, updatedAt: 'T', updatedBy: 'u' }),
    );
    const { bus } = bootBus(storage);
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET], ttlMs: 0 }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:get-policy', ctx, {})).toEqual({
      allowed: [OPUS],
      default: OPUS,
      source: 'admin',
      version: 2,
    });
  });
});
