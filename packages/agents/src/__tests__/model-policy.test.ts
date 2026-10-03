import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { builtinPolicy, loadPolicy } from '../model-policy.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';

function logger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  const l = {
    errors,
    debug() {},
    info() {},
    warn() {},
    error(msg: string) {
      errors.push(msg);
    },
    child() {
      return l;
    },
  } as Logger & { errors: string[] };
  return l;
}

describe('builtinPolicy', () => {
  it('prefers Claude Sonnet as the Default, else the first entry', () => {
    expect(builtinPolicy([OPUS, SONNET])).toEqual({ allowed: [OPUS, SONNET], default: SONNET });
    expect(builtinPolicy([KIMI, OPUS])).toEqual({ allowed: [KIMI, OPUS], default: KIMI });
  });
});

describe('loadPolicy', () => {
  const boot = builtinPolicy([OPUS, SONNET]);

  it('returns the boot policy when models:get-policy is not registered', async () => {
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    expect(await loadPolicy(new HookBus(), ctx, boot)).toBe(boot);
  });

  it("returns the hook's answer when it is registered", async () => {
    const bus = new HookBus();
    bus.registerService('models:get-policy', 'test', async () => ({
      allowed: [KIMI, SONNET],
      default: KIMI,
      source: 'admin',
      version: 3,
    }));
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    expect(await loadPolicy(bus, ctx, boot)).toEqual({ allowed: [KIMI, SONNET], default: KIMI });
  });

  it('falls back to the boot policy and logs when the hook throws', async () => {
    const bus = new HookBus();
    bus.registerService('models:get-policy', 'test', async () => {
      throw new Error('storage down');
    });
    const log = logger();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: log });
    expect(await loadPolicy(bus, ctx, boot)).toBe(boot);
    expect(log.errors).toEqual(['agents_model_policy_unavailable']);
  });

  it('falls back to the boot policy and logs when the answer is unusable', async () => {
    const bus = new HookBus();
    bus.registerService('models:get-policy', 'test', async () => ({
      allowed: [KIMI],
      default: SONNET, // not in allowed
      source: 'admin',
      version: 1,
    }));
    const log = logger();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: log });
    expect(await loadPolicy(bus, ctx, boot)).toBe(boot);
    expect(log.errors).toEqual(['agents_model_policy_invalid']);
  });
});
import { applyPolicy } from '../model-policy.js';
import type { Agent } from '../types.js';

const baseAgent: Agent = {
  id: 'agt_1',
  ownerId: 'u1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'A',
  allowedTools: [],
  mcpConfigIds: [],
  model: KIMI,
  runner: 'aisdk',
  workspaceRef: null,
  skillAttachments: [],
  connectorAttachments: [],
  connectorExclusions: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('applyPolicy', () => {
  const policy = { allowed: [SONNET, OPUS], default: SONNET };

  it('swaps a no-longer-allowed model for the Default, re-derives the runner, and records the request', () => {
    const out = applyPolicy(baseAgent, policy);
    expect(out).toMatchObject({ model: SONNET, runner: 'claude-sdk', requestedModel: KIMI });
  });

  it('returns the very same object when the model is allowed and compatible', () => {
    const agent = { ...baseAgent, model: SONNET, runner: 'claude-sdk' as const };
    expect(applyPolicy(agent, policy)).toBe(agent);
  });

  it('keeps an explicit aisdk runner on an allowed Anthropic model', () => {
    const agent = { ...baseAgent, model: SONNET, runner: 'aisdk' as const };
    expect(applyPolicy(agent, policy)).toBe(agent);
  });

  it('heals an allowed non-Anthropic model stuck on claude-sdk (runs on aisdk) without claiming a swap', () => {
    const agent = { ...baseAgent, model: KIMI, runner: 'claude-sdk' as const };
    const out = applyPolicy(agent, { allowed: [KIMI, SONNET], default: SONNET });
    expect(out).toMatchObject({ model: KIMI, runner: 'aisdk' });
    expect(out.requestedModel).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const snapshot = { ...baseAgent };
    applyPolicy(baseAgent, policy);
    expect(baseAgent).toEqual(snapshot);
  });
});
