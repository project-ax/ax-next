import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HookBus,
  PluginError,
  makeChatContext,
  createLogger,
  type LlmRequest,
  type LlmResponse,
} from '@ax/core';
import { createLlmAnthropicPlugin } from '../plugin.js';

const ctx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

function makeFakeClient(responses: unknown[]) {
  const queue = [...responses];
  const seen: unknown[] = [];
  const create = async (req: unknown) => {
    seen.push(req);
    const next = queue.shift();
    if (next === undefined) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { messages: { create }, seen };
}

function apiError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('llm-anthropic', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('happy path: maps text-only response', async () => {
    const client = makeFakeClient([{ content: [{ type: 'text', text: 'hi' }] }]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ clientFactory: () => client }).init({ bus, config: {} });
    const r = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(r.assistantMessage).toMatchObject({ role: 'assistant', content: 'hi' });
    expect(r.toolCalls).toEqual([]);
  });

  it('routes system messages to top-level system, not role:user', async () => {
    const client = makeFakeClient([{ content: [{ type: 'text', text: 'ok' }] }]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ clientFactory: () => client }).init({ bus, config: {} });
    await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Reply with one word.' },
      ],
    });
    expect(client.seen).toHaveLength(1);
    const req = client.seen[0] as { messages: Array<{ role: string; content: string }>; system?: string };
    expect(req.system).toBe('You are terse.\n\nReply with one word.');
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('maps tool_use block to toolCalls[]', async () => {
    const client = makeFakeClient([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }],
      },
    ]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ clientFactory: () => client }).init({ bus, config: {} });
    const r = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [{ role: 'user', content: 'list' }],
    });
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'bash', input: { command: 'ls' } }]);
  });

  it('missing ANTHROPIC_API_KEY at init -> PluginError with no key leak', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const bus = new HookBus();
    let err: unknown;
    try {
      await createLlmAnthropicPlugin({}).init({ bus, config: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('init-failed');
    expect((err as PluginError).message).not.toMatch(/sk-|key-value/i);
  });

  it('API 401: surfaces PluginError with redacted message', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-supersecret';
    const client = makeFakeClient([apiError(401, 'Bad key: sk-supersecret')]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ clientFactory: () => client }).init({ bus, config: {} });
    const err = await bus
      .call('llm:call', ctx(), { messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).message).not.toContain('sk-supersecret');
    expect((err as PluginError).message).toContain('<redacted>');
  });

  it('API 500 then 200: retries once and returns success', async () => {
    const client = makeFakeClient([
      apiError(500, 'boom'),
      { content: [{ type: 'text', text: 'recovered' }] },
    ]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ clientFactory: () => client, retryDelayMs: 10 }).init({ bus, config: {} });
    const r = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(r.assistantMessage.content).toBe('recovered');
    expect(client.seen.length).toBe(2);
  });

  it('API 500 twice: surfaces PluginError with no key in message', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-second';
    const client = makeFakeClient([
      apiError(500, 'server on fire sk-second context'),
      apiError(500, 'still fire'),
    ]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ clientFactory: () => client, retryDelayMs: 10 }).init({ bus, config: {} });
    const err = await bus
      .call('llm:call', ctx(), { messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).message).not.toContain('sk-second');
  });

  it('I5: AX_TEST_ANTHROPIC_FIXTURE env var is ignored (no dynamic import backdoor)', async () => {
    process.env.AX_TEST_ANTHROPIC_FIXTURE = '/tmp/evil-path-that-does-not-exist.mjs';
    try {
      const client = makeFakeClient([{ content: [{ type: 'text', text: 'ok' }] }]);
      const bus = new HookBus();
      await createLlmAnthropicPlugin({ clientFactory: () => client }).init({ bus, config: {} });
      expect(bus.hasService('llm:call')).toBe(true);
      // If AX_TEST_ANTHROPIC_FIXTURE were honored, init would try to import from the
      // bogus path and throw MODULE_NOT_FOUND. The fact that init succeeded proves the
      // backdoor is not present.
    } finally {
      delete process.env.AX_TEST_ANTHROPIC_FIXTURE;
    }
  });
});
