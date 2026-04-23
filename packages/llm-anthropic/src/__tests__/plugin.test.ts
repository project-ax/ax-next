import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { HookBus, PluginError, makeChatContext, type LlmRequest, type LlmResponse } from '@ax/core';
import { llmAnthropicPlugin, type AnthropicPluginConfig } from '../plugin.js';

function ctx() {
  return makeChatContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

function mkMessage(content: unknown[], stop_reason = 'end_turn'): Anthropic.Messages.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Messages.Message;
}

async function bootWithClient(
  client: Pick<Anthropic, 'messages'>,
  extra: Partial<AnthropicPluginConfig> = {},
): Promise<HookBus> {
  const bus = new HookBus();
  const p = llmAnthropicPlugin();
  await p.init({ bus, config: { client, ...extra } satisfies AnthropicPluginConfig });
  return bus;
}

describe('@ax/llm-anthropic plugin', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('happy path: returns assistantMessage for text content', async () => {
    const create = vi.fn().mockResolvedValue(
      mkMessage([{ type: 'text', text: 'hi', citations: null }]),
    );
    const bus = await bootWithClient({ messages: { create } as never });

    const res = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.assistantMessage).toEqual({ role: 'assistant', content: 'hi' });
    expect(res.toolCalls).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps a tool_use block to ToolCall[]', async () => {
    const create = vi.fn().mockResolvedValue(
      mkMessage(
        [{ type: 'tool_use', id: 'x', name: 'bash', input: { command: 'ls' } }],
        'tool_use',
      ),
    );
    const bus = await bootWithClient({ messages: { create } as never });

    const res = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [{ role: 'user', content: 'list' }],
    });
    expect(res.toolCalls).toEqual([{ id: 'x', name: 'bash', input: { command: 'ls' } }]);
  });

  it('throws PluginError(init-failed) when ANTHROPIC_API_KEY is missing and no client is injected', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const bus = new HookBus();
    const p = llmAnthropicPlugin();
    let caught: unknown;
    try {
      await p.init({ bus, config: undefined });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('init-failed');
    expect((caught as PluginError).plugin).toBe('@ax/llm-anthropic');
  });

  it('wraps SDK errors as PluginError with a generic message', async () => {
    const create = vi.fn().mockRejectedValue(
      new Error('401 Unauthorized: full response body with sensitive details'),
    );
    const bus = await bootWithClient({ messages: { create } as never });

    let caught: unknown;
    try {
      await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
        messages: [{ role: 'user', content: 'x' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    const err = caught as PluginError;
    expect(err.code).toBe('unknown');
    expect(err.hookName).toBe('llm:call');
    expect(err.message).toBe('anthropic API error');
    expect(err.message).not.toContain('401');
    expect(err.message).not.toContain('Unauthorized');
  });

  it('does not leak the API key when the SDK error echoes it', async () => {
    process.env.ANTHROPIC_API_KEY = 'totally-secret-key';
    const create = vi.fn().mockRejectedValue(
      new Error('auth failed with key totally-secret-key'),
    );
    const bus = await bootWithClient({ messages: { create } as never });

    let caught: unknown;
    try {
      await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
        messages: [{ role: 'user', content: 'x' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    // PluginError.toJSON intentionally omits cause, so JSON-stringifying the
    // error must not expose the secret that lived in the underlying cause.
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain('totally-secret-key');
  });

  it('does not forward tools to the Anthropic API until schemas are threaded', async () => {
    const create = vi.fn().mockResolvedValue(
      mkMessage([{ type: 'text', text: 'ok', citations: null }]),
    );
    const bus = await bootWithClient({ messages: { create } as never });

    await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'bash', description: 'run bash' }],
    });

    const args = create.mock.calls[0]![0];
    expect(args.tools).toBeUndefined();
    expect('tools' in args).toBe(false);
  });

  it('forwards system messages as the top-level system field', async () => {
    const create = vi.fn().mockResolvedValue(
      mkMessage([{ type: 'text', text: 'ok', citations: null }]),
    );
    const bus = await bootWithClient({ messages: { create } as never });

    await bus.call<LlmRequest, LlmResponse>('llm:call', ctx(), {
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
    });

    const args = create.mock.calls[0]![0];
    expect(args.system).toBe('be brief');
    expect(args.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
