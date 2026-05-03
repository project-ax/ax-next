import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fromAnthropicResponse, toAnthropicRequest } from '../translate.js';

describe('toAnthropicRequest', () => {
  it('uses the default model and the input maxTokens, copies messages through', () => {
    const req = toAnthropicRequest(
      { messages: [{ role: 'user', content: 'hello' }], maxTokens: 32 },
      {},
    );
    expect(req).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('honors cfg.defaultModel when input.model is unset', () => {
    const req = toAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { defaultModel: 'override-model' },
    );
    expect(req.model).toBe('override-model');
  });

  it('lets input.model override cfg.defaultModel', () => {
    const req = toAnthropicRequest(
      { model: 'caller-model', messages: [{ role: 'user', content: 'hi' }] },
      { defaultModel: 'cfg-model' },
    );
    expect(req.model).toBe('caller-model');
  });

  it('falls back to cfg.defaultMaxTokens, then to the package default', () => {
    const a = toAnthropicRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { defaultMaxTokens: 128 },
    );
    expect(a.max_tokens).toBe(128);

    const b = toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(b.max_tokens).toBe(4096);
  });

  it('passes through system when set, omits when unset', () => {
    const withSystem = toAnthropicRequest(
      { system: 'you are a robot', messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    expect(withSystem.system).toBe('you are a robot');

    const without = toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(without.system).toBeUndefined();
  });

  it('passes through temperature when set, omits when unset', () => {
    const withTemp = toAnthropicRequest(
      { temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    expect(withTemp.temperature).toBe(0.2);

    const without = toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(without.temperature).toBeUndefined();
  });
});

describe('fromAnthropicResponse', () => {
  it('extracts text and usage from a single text-block response', () => {
    const res = makeMessage({
      content: [{ type: 'text', text: 'Hello' } as Anthropic.TextBlock],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    expect(fromAnthropicResponse(res)).toEqual({
      text: 'Hello',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
  });

  it('concatenates multiple text blocks with no separator', () => {
    const res = makeMessage({
      content: [
        { type: 'text', text: 'Hello' } as Anthropic.TextBlock,
        { type: 'text', text: 'World' } as Anthropic.TextBlock,
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(fromAnthropicResponse(res).text).toBe('HelloWorld');
  });

  it('skips non-text blocks (e.g. tool_use) and concatenates the text either side', () => {
    const res = makeMessage({
      content: [
        { type: 'text', text: 'A' } as Anthropic.TextBlock,
        { type: 'tool_use', id: 't1', name: 'do_thing', input: {} } as unknown as Anthropic.ContentBlock,
        { type: 'text', text: 'B' } as Anthropic.TextBlock,
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(fromAnthropicResponse(res).text).toBe('AB');
  });

  it('maps stop_reason: null to stopReason: "unknown"', () => {
    const res = makeMessage({
      content: [{ type: 'text', text: 'x' } as Anthropic.TextBlock],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(fromAnthropicResponse(res).stopReason).toBe('unknown');
  });

  it('maps stop_reason: "tool_use" through verbatim', () => {
    const res = makeMessage({
      content: [{ type: 'text', text: 'x' } as Anthropic.TextBlock],
      stop_reason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(fromAnthropicResponse(res).stopReason).toBe('tool_use');
  });

  it('maps stop_reason: "max_tokens" and "stop_sequence" through verbatim', () => {
    const a = fromAnthropicResponse(
      makeMessage({
        content: [{ type: 'text', text: 'x' } as Anthropic.TextBlock],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(a.stopReason).toBe('max_tokens');

    const b = fromAnthropicResponse(
      makeMessage({
        content: [{ type: 'text', text: 'x' } as Anthropic.TextBlock],
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(b.stopReason).toBe('stop_sequence');
  });

  it('maps unrecognized provider-specific stop reasons (e.g. "pause_turn", "refusal") to "unknown"', () => {
    const a = fromAnthropicResponse(
      makeMessage({
        content: [{ type: 'text', text: 'x' } as Anthropic.TextBlock],
        stop_reason: 'pause_turn' as Anthropic.StopReason,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(a.stopReason).toBe('unknown');

    const b = fromAnthropicResponse(
      makeMessage({
        content: [{ type: 'text', text: 'x' } as Anthropic.TextBlock],
        stop_reason: 'refusal' as Anthropic.StopReason,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(b.stopReason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Helper: construct a minimum-viable Anthropic.Message for the translator. We
// only set the fields the translator reads; the SDK's Message type carries a
// pile of provider metadata we don't care about here.
// ---------------------------------------------------------------------------
function makeMessage(opts: {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason | null;
  usage: { input_tokens: number; output_tokens: number };
}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: opts.content,
    stop_reason: opts.stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: opts.usage.input_tokens,
      output_tokens: opts.usage.output_tokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}
