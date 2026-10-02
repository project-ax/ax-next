import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { createLlmOpenRouterPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-692 — every successful host-side call reports its spend on `llm:usage`
// so the per-user limiter can meter titles / memory extraction / safety scans.
// A stub `fetch` answers; the suite never opens a socket.
// ---------------------------------------------------------------------------

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const OK_BODY = {
  id: 'gen-test',
  model: 'x-ai/grok-4.6',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 22 },
};

const INPUT: LlmCallInput = {
  model: 'x-ai/grok-4.6',
  messages: [{ role: 'user', content: 'Hi' }],
  maxTokens: 32,
};

async function boot(
  fetchImpl: typeof fetch,
): Promise<{ bus: HookBus; seen: Array<{ userId: string; payload: unknown }> }> {
  const seen: Array<{ userId: string; payload: unknown }> = [];
  const plugin = createLlmOpenRouterPlugin({ apiKey: 'sk-or-test-key', retryDelayMs: 0, fetchImpl });
  const bus = new HookBus();
  bus.subscribe<unknown>('llm:usage', 'test-meter', async (ctx, payload) => {
    seen.push({ userId: ctx.userId, payload });
    return undefined;
  });
  await plugin.init({ bus, config: {} });
  return { bus, seen };
}

describe('@ax/llm-openrouter reports usage on llm:usage', () => {
  it('fires once per successful call with an openrouter/<slug> ref, attributed to ctx.userId', async () => {
    const { bus, seen } = await boot(fetchReturning(200, OK_BODY));
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u-42' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT);
    expect(seen).toEqual([
      {
        userId: 'u-42',
        payload: { model: 'openrouter/x-ai/grok-4.6', usage: { inputTokens: 11, outputTokens: 22 } },
      },
    ]);
  });

  it('names the default model when the caller does not', async () => {
    const { bus, seen } = await boot(fetchReturning(200, OK_BODY));
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, {
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 32,
    });
    expect((seen[0]!.payload as { model: string }).model).toBe('openrouter/google/gemini-3.7-flash');
  });

  it('fires nothing for a failed call', async () => {
    const { bus, seen } = await boot(fetchReturning(400, { error: 'nope' }));
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await expect(bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT)).rejects.toBeInstanceOf(
      PluginError,
    );
    expect(seen).toEqual([]);
  });

  it('still returns the answer when a usage subscriber throws (metering never fails a call)', async () => {
    const plugin = createLlmOpenRouterPlugin({
      apiKey: 'sk-or-test-key',
      retryDelayMs: 0,
      fetchImpl: fetchReturning(200, OK_BODY),
    });
    const bus = new HookBus();
    bus.subscribe<unknown>('llm:usage', 'broken-meter', async () => {
      throw new Error('meter down');
    });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT);
    expect(out.text).toBe('hello back');
  });
});

describe('spend circuit breaker (TASK-716)', () => {
  it.each(['blocked', 'unavailable'])(
    'makes no provider call when the usage gate is %s',
    async (mode) => {
      let calls = 0;
      const { bus, seen } = await boot((async () => {
        calls++;
        return new Response(JSON.stringify(OK_BODY));
      }) as typeof fetch);
      bus.registerService('usage:check', 'test-limit', async () => {
        if (mode === 'unavailable') throw new Error('database down');
        return { blocked: true, reason: 'usage-limit-fleet' };
      });
      await expect(
        bus.call(
          'llm:call:openrouter',
          makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' }),
          INPUT,
        ),
      ).rejects.toBeInstanceOf(PluginError);
      expect(calls).toBe(0);
      expect(seen).toEqual([]);
    },
  );
});
