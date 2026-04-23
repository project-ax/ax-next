import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { fromAnthropicMessage, toAnthropicMessages } from '../mapping.js';

describe('toAnthropicMessages', () => {
  it('passes user-only messages through with no system string', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ]);
    expect(out.system).toBeUndefined();
    expect(out.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ]);
  });

  it('pulls a single system message out into the system field', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out.system).toBe('be brief');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('concatenates multiple system messages with newlines', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'be brief' },
      { role: 'system', content: 'be kind' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out.system).toBe('be brief\nbe kind');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

function mkResp(content: Anthropic.Messages.ContentBlock[]): Anthropic.Messages.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Messages.Message;
}

describe('fromAnthropicMessage', () => {
  it('maps a text-only response', () => {
    const resp = mkResp([{ type: 'text', text: 'hello', citations: null } as Anthropic.Messages.ContentBlock]);
    const out = fromAnthropicMessage(resp);
    expect(out.assistantMessage).toEqual({ role: 'assistant', content: 'hello' });
    expect(out.toolCalls).toEqual([]);
  });

  it('extracts tool_use into ToolCall[]', () => {
    const resp = mkResp([
      { type: 'tool_use', id: 'x', name: 'bash', input: { command: 'ls' } } as Anthropic.Messages.ContentBlock,
    ]);
    const out = fromAnthropicMessage(resp);
    expect(out.assistantMessage).toEqual({ role: 'assistant', content: '' });
    expect(out.toolCalls).toEqual([{ id: 'x', name: 'bash', input: { command: 'ls' } }]);
  });

  it('captures both text and tool_use', () => {
    const resp = mkResp([
      { type: 'text', text: 'sure, running: ', citations: null } as Anthropic.Messages.ContentBlock,
      { type: 'tool_use', id: 'y', name: 'bash', input: { command: 'pwd' } } as Anthropic.Messages.ContentBlock,
    ]);
    const out = fromAnthropicMessage(resp);
    expect(out.assistantMessage.content).toBe('sure, running: ');
    expect(out.toolCalls).toEqual([{ id: 'y', name: 'bash', input: { command: 'pwd' } }]);
  });
});
