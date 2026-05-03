import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import type Anthropic from '@anthropic-ai/sdk';
import { createLlmAnthropicPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Stub Anthropic client. We only implement messages.create — the translator
// reads `id/role/type/model/content/stop_reason/usage` off the response, and
// the retry path only cares whether `create` resolves or throws.
// ---------------------------------------------------------------------------
function makeStubClient(create: (req: unknown) => Promise<Anthropic.Message>): Anthropic {
  return {
    messages: { create },
  } as unknown as Anthropic;
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

// Mimic the SDK's APIError shape — only the `.status` field is load-bearing
// for the retry decision. We inherit from Error so PluginError's cause
// preserves the stack.
class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}

const ORIGINAL_ENV_KEY = process.env.ANTHROPIC_API_KEY;

describe('@ax/llm-anthropic plugin manifest', () => {
  it('declares registers: ["llm:call"], no calls, no subscribes', () => {
    const plugin = createLlmAnthropicPlugin({ apiKey: 'test-key' });
    expect(plugin.manifest).toEqual({
      name: '@ax/llm-anthropic',
      version: '0.0.0',
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    });
  });
});

describe('@ax/llm-anthropic init', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL_ENV_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV_KEY;
    }
  });

  it('throws init-failed when neither cfg.apiKey nor ANTHROPIC_API_KEY is set', async () => {
    const plugin = createLlmAnthropicPlugin();
    const bus = new HookBus();
    await expect(plugin.init({ bus, config: {} })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'init-failed',
      plugin: '@ax/llm-anthropic',
      hookName: 'init',
    });
  });

  it('throws init-failed when cfg.apiKey is the empty string', async () => {
    const plugin = createLlmAnthropicPlugin({ apiKey: '' });
    const bus = new HookBus();
    await expect(plugin.init({ bus, config: {} })).rejects.toMatchObject({
      code: 'init-failed',
    });
  });

  it('succeeds when cfg.apiKey is provided and registers llm:call', async () => {
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      clientFactory: () => makeStubClient(async () => makeMessage('hi')),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    expect(bus.hasService('llm:call')).toBe(true);
  });

  it('succeeds when ANTHROPIC_API_KEY env var is set and cfg.apiKey is unset', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const plugin = createLlmAnthropicPlugin({
      clientFactory: () => makeStubClient(async () => makeMessage('hi')),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    expect(bus.hasService('llm:call')).toBe(true);
  });
});

describe('@ax/llm-anthropic llm:call dispatch', () => {
  it('forwards translated input to the SDK and returns translated output', async () => {
    const create = vi.fn(async () => makeMessage('hello back'));
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      clientFactory: () => makeStubClient(create),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const input: LlmCallInput = {
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 32,
    };
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call', ctx, input);

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(out).toEqual({
      text: 'hello back',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('retries once after a transient 5xx and then succeeds', async () => {
    let attempts = 0;
    const create = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new FakeApiError(503, 'service unavailable');
      return makeMessage('ok');
    });
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      retryDelayMs: 0,
      clientFactory: () => makeStubClient(create),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call', ctx, {
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(out.text).toBe('ok');
  });

  it('retries once after a 429 (rate limit) and then succeeds', async () => {
    let attempts = 0;
    const create = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new FakeApiError(429, 'rate limited');
      return makeMessage('ok');
    });
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      retryDelayMs: 0,
      clientFactory: () => makeStubClient(create),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call', ctx, {
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.text).toBe('ok');
  });

  it('does not retry a 4xx (non-429) and surfaces a PluginError immediately', async () => {
    const create = vi.fn(async () => {
      throw new FakeApiError(400, 'bad request');
    });
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      retryDelayMs: 0,
      clientFactory: () => makeStubClient(create),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

    let caught: unknown;
    try {
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call', ctx, {
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(caught).toMatchObject({
      code: 'unknown',
      plugin: '@ax/llm-anthropic',
      hookName: 'llm:call',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('exhausts the single retry on a persistent 5xx and surfaces PluginError', async () => {
    const create = vi.fn(async () => {
      throw new FakeApiError(500, 'internal');
    });
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      retryDelayMs: 0,
      clientFactory: () => makeStubClient(create),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

    let caught: unknown;
    try {
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call', ctx, {
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(caught).toMatchObject({
      code: 'unknown',
      plugin: '@ax/llm-anthropic',
      hookName: 'llm:call',
    });
    // 1 initial + 1 retry = 2 attempts.
    expect(create).toHaveBeenCalledTimes(2);
  });
});
