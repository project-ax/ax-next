import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import type Anthropic from '@anthropic-ai/sdk';
import { createLlmAnthropicPlugin, type LlmAnthropicConfig } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-692 — every successful host-side call reports its spend on `llm:usage`
// so the per-user limiter can meter titles / memory extraction / safety scans.
// These tests drive a stub client; nothing here opens a socket.
// ---------------------------------------------------------------------------

function makeStubClient(create: (req: unknown) => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function makeMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}

const INPUT: LlmCallInput = { messages: [{ role: 'user', content: 'Hi' }], maxTokens: 32 };

async function boot(
  over: LlmAnthropicConfig = {},
  create: (req: unknown) => Promise<Anthropic.Message> = async () => makeMessage('hi'),
): Promise<{ bus: HookBus; seen: Array<{ userId: string; payload: unknown }> }> {
  const seen: Array<{ userId: string; payload: unknown }> = [];
  const plugin = createLlmAnthropicPlugin({
    apiKey: 'test-key',
    retryDelayMs: 0,
    clientFactory: () => makeStubClient(create),
    ...over,
  });
  const bus = new HookBus();
  bus.subscribe<unknown>('llm:usage', 'test-meter', async (ctx, payload) => {
    seen.push({ userId: ctx.userId, payload });
    return undefined;
  });
  await plugin.init({ bus, config: {} });
  return { bus, seen };
}

describe('@ax/llm-anthropic reports usage on llm:usage', () => {
  it('fires once per successful call, attributed to ctx.userId, with a provider/model ref', async () => {
    const { bus, seen } = await boot();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u-42' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
      ...INPUT,
      model: 'claude-sonnet-4-6',
    });
    expect(seen).toEqual([
      {
        userId: 'u-42',
        payload: { model: 'anthropic/claude-sonnet-4-6', usage: { inputTokens: 1, outputTokens: 2 } },
      },
    ]);
  });

  it('names the default model when the caller does not', async () => {
    const { bus, seen } = await boot();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, INPUT);
    expect((seen[0]!.payload as { model: string }).model).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('names cfg.defaultModel when that is what served the call', async () => {
    const { bus, seen } = await boot({ defaultModel: 'claude-sonnet-4-6' });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, INPUT);
    expect((seen[0]!.payload as { model: string }).model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('fires nothing for a failed call', async () => {
    const { bus, seen } = await boot({}, async () => {
      throw new FakeApiError(400, 'bad request');
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await expect(bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, INPUT)).rejects.toBeInstanceOf(
      PluginError,
    );
    expect(seen).toEqual([]);
  });

  it('still returns the answer when a usage subscriber throws (metering never fails a call)', async () => {
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      clientFactory: () => makeStubClient(async () => makeMessage('hi')),
    });
    const bus = new HookBus();
    bus.subscribe<unknown>('llm:usage', 'broken-meter', async () => {
      throw new Error('meter down');
    });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, INPUT);
    expect(out.text).toBe('hi');
  });

  it('reports in credential-resolution mode too', async () => {
    const { bus, seen } = await boot({ credentialResolution: true });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, INPUT);
    expect(seen).toHaveLength(1);
  });
});

describe('spend circuit breaker (TASK-716)', () => {
  it.each(['blocked', 'unavailable'])(
    'makes no provider call when the usage gate is %s',
    async (mode) => {
      let calls = 0;
      const { bus, seen } = await boot({}, async () => {
        calls++;
        return makeMessage('hi');
      });
      bus.registerService('usage:check', 'test-limit', async () => {
        if (mode === 'unavailable') throw new Error('database down');
        return { blocked: true, reason: 'usage-limit-fleet' };
      });
      await expect(
        bus.call(
          'llm:call:anthropic',
          makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' }),
          INPUT,
        ),
      ).rejects.toBeInstanceOf(PluginError);
      expect(calls).toBe(0);
      expect(seen).toEqual([]);
    },
  );
});
