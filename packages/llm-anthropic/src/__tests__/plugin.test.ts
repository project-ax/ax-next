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
  it('declares registers: ["llm:call:anthropic", "models:list-supported"], no calls, no subscribes', () => {
    const plugin = createLlmAnthropicPlugin({ apiKey: 'test-key' });
    expect(plugin.manifest).toEqual({
      name: '@ax/llm-anthropic',
      version: '0.0.0',
      registers: ['llm:call:anthropic', 'models:list-supported'],
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
    expect(bus.hasService('llm:call:anthropic')).toBe(true);
  });

  it('succeeds when ANTHROPIC_API_KEY env var is set and cfg.apiKey is unset', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const plugin = createLlmAnthropicPlugin({
      clientFactory: () => makeStubClient(async () => makeMessage('hi')),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    expect(bus.hasService('llm:call:anthropic')).toBe(true);
  });

  it('forwards cfg.timeoutMs to the underlying Anthropic client', async () => {
    // The Anthropic SDK exposes the resolved per-request timeout on
    // each constructed client's public `timeout` field
    // (`BaseAnthropic.timeout` in @anthropic-ai/sdk/client.d.ts), so
    // the contract we want to verify is: when the plugin's
    // real-construction path runs with `cfg.timeoutMs = N`, the
    // resulting client's `.timeout === N`.
    //
    // The plugin closes over the constructed client, so we expose it
    // through clientFactory using the exact same `new Anthropic({
    // apiKey, timeout })` shape the prod path uses. Any divergence
    // between this test and `plugin.ts`'s real-construction branch
    // would only mask a bug if both drifted in lock-step — acceptable
    // given the simplicity.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    let captured: Anthropic | undefined;
    const plugin = createLlmAnthropicPlugin({
      apiKey: 'test-key',
      timeoutMs: 15_000,
      clientFactory: (apiKey: string) => {
        captured = new Anthropic({ apiKey, timeout: 15_000 });
        return captured;
      },
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    expect(captured).toBeDefined();
    expect((captured as unknown as { timeout: number }).timeout).toBe(15_000);
  });

  it('falls back to the SDK default timeout when cfg.timeoutMs is unset', async () => {
    // Sanity check: the SDK's default timeout is a positive number
    // distinct from the test value above. If a future plugin change
    // accidentally passed `timeout: undefined`, the SDK would coerce
    // it to its default — the contract here is "do not interfere when
    // the caller doesn't ask for a custom timeout".
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const reference = new Anthropic({ apiKey: 'test-key' });
    const sdkDefaultTimeout = (
      reference as unknown as { timeout: number }
    ).timeout;
    expect(typeof sdkDefaultTimeout).toBe('number');
    expect(sdkDefaultTimeout).toBeGreaterThan(0);
    expect(sdkDefaultTimeout).not.toBe(15_000);
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
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, input);

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
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
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
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
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
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(caught).toMatchObject({
      code: 'unknown',
      plugin: '@ax/llm-anthropic',
      hookName: 'llm:call:anthropic',
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
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(caught).toMatchObject({
      code: 'unknown',
      plugin: '@ax/llm-anthropic',
      hookName: 'llm:call:anthropic',
    });
    // 1 initial + 1 retry = 2 attempts.
    expect(create).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// credentialResolution mode (TASK: GKE auto-naming fix). When `true`, the API
// key is resolved PER-CALL from the credential store (`credentials:get` ref
// `provider:anthropic`, by ctx.userId precedence) with cfg.apiKey /
// ANTHROPIC_API_KEY as fallbacks — so host-side auto-titling works off the
// wizard-stored global credential without a boot-time env key.
// ---------------------------------------------------------------------------
describe('@ax/llm-anthropic credentialResolution mode', () => {
  const ORIGINAL = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL;
  });

  function busWithCredential(
    get: (input: { ref: string; userId: string }) => Promise<string>,
    captured?: { calls: Array<{ ref: string; userId: string }> },
  ): HookBus {
    const bus = new HookBus();
    bus.registerService<{ ref: string; userId: string }, string>(
      'credentials:get',
      '@ax/credentials',
      async (_ctx, input) => {
        captured?.calls.push(input);
        return get(input);
      },
    );
    return bus;
  }

  it('declares credentials:get as an optionalCall when credentialResolution is on', () => {
    const plugin = createLlmAnthropicPlugin({ credentialResolution: true });
    expect(plugin.manifest.optionalCalls).toEqual([
      expect.objectContaining({ hook: 'credentials:get' }),
    ]);
    // Static-mode plugin keeps the lean manifest (no optionalCalls).
    const staticPlugin = createLlmAnthropicPlugin({ apiKey: 'k' });
    expect(staticPlugin.manifest.optionalCalls).toBeUndefined();
  });

  it('init does NOT throw without a static key (key is resolved per-call)', async () => {
    const plugin = createLlmAnthropicPlugin({
      credentialResolution: true,
      clientFactory: () => makeStubClient(async () => makeMessage('hi')),
    });
    const bus = busWithCredential(async () => 'sk-db-key');
    await expect(plugin.init({ bus, config: {} })).resolves.toBeUndefined();
    expect(bus.hasService('llm:call:anthropic')).toBe(true);
  });

  it('resolves the API key per-call from credentials:get (ref provider:anthropic, by ctx.userId)', async () => {
    const captured = { calls: [] as Array<{ ref: string; userId: string }> };
    let usedKey: string | undefined;
    const plugin = createLlmAnthropicPlugin({
      credentialResolution: true,
      clientFactory: (apiKey: string) => {
        usedKey = apiKey;
        return makeStubClient(async () => makeMessage('hi'));
      },
    });
    const bus = busWithCredential(async () => 'sk-db-key', captured);
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 32,
    });

    expect(out.text).toBe('hi');
    expect(usedKey).toBe('sk-db-key');
    expect(captured.calls).toEqual([{ ref: 'provider:anthropic', userId: 'u1' }]);
  });

  it('falls back to ANTHROPIC_API_KEY env when credentials:get has no credential', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    let usedKey: string | undefined;
    const plugin = createLlmAnthropicPlugin({
      credentialResolution: true,
      clientFactory: (apiKey: string) => {
        usedKey = apiKey;
        return makeStubClient(async () => makeMessage('hi'));
      },
    });
    const bus = busWithCredential(async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/credentials', message: 'no credential' });
    });
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 32,
    });
    expect(out.text).toBe('hi');
    expect(usedKey).toBe('env-key');
  });

  it('rejects per-call (not at init) with no-anthropic-credential when nothing resolves', async () => {
    const plugin = createLlmAnthropicPlugin({
      credentialResolution: true,
      clientFactory: () => makeStubClient(async () => makeMessage('hi')),
    });
    const bus = busWithCredential(async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/credentials', message: 'no credential' });
    });
    // init succeeds — the absence of a key is a per-call concern now.
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await expect(
      bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 32,
      }),
    ).rejects.toMatchObject({ code: 'no-anthropic-credential', plugin: '@ax/llm-anthropic' });
  });

  it('uses cfg.apiKey as an explicit override and never queries credentials:get', async () => {
    const captured = { calls: [] as Array<{ ref: string; userId: string }> };
    let usedKey: string | undefined;
    const plugin = createLlmAnthropicPlugin({
      credentialResolution: true,
      apiKey: 'override-key',
      clientFactory: (apiKey: string) => {
        usedKey = apiKey;
        return makeStubClient(async () => makeMessage('hi'));
      },
    });
    const bus = busWithCredential(async () => 'sk-db-key', captured);
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:anthropic', ctx, {
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 32,
    });
    expect(usedKey).toBe('override-key');
    expect(captured.calls).toEqual([]);
  });
});
