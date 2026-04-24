import { describe, it, expect } from 'vitest';
import { translateLlmResponse } from '../translate-response.js';
import type { LlmCallResponse } from '@ax/ipc-protocol';

const MSG_ID_REGEX = /^msg_[a-z0-9]+$/i;

describe('translateLlmResponse', () => {
  it('renders a pure text response as a single text block', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'hello' },
      toolCalls: [],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.stop_reason).toBe('end_turn');
    expect(out.stop_sequence).toBeNull();
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.id).toMatch(MSG_ID_REGEX);
  });

  it('emits text + tool_use blocks with stop_reason tool_use', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'running now' },
      toolCalls: [
        { id: 'tu_1', name: 'Bash', input: { command: 'echo ok' } },
      ],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.content).toEqual([
      { type: 'text', text: 'running now' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Bash',
        input: { command: 'echo ok' },
      },
    ]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('omits empty text block when content is empty and tool calls present', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: '' },
      toolCalls: [{ id: 'tu_1', name: 'Bash', input: {} }],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
    ]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('preserves order of multiple tool calls', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'x' },
      toolCalls: [
        { id: 'tu_1', name: 'A', input: { a: 1 } },
        { id: 'tu_2', name: 'B', input: { b: 2 } },
        { id: 'tu_3', name: 'C', input: { c: 3 } },
      ],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.content).toEqual([
      { type: 'text', text: 'x' },
      { type: 'tool_use', id: 'tu_1', name: 'A', input: { a: 1 } },
      { type: 'tool_use', id: 'tu_2', name: 'B', input: { b: 2 } },
      { type: 'tool_use', id: 'tu_3', name: 'C', input: { c: 3 } },
    ]);
  });

  it('passes through usage in snake_case', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it('defaults usage to zeros when missing', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('defaults individual usage fields to zero when partial', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
      usage: { inputTokens: 5 },
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 0 });
  });

  it('honors caller-supplied genId seam', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6', {
      genId: () => 'msg_deadbeef',
    });
    expect(out.id).toBe('msg_deadbeef');
  });

  it('generated id always matches msg_<alnum> shape', () => {
    for (let i = 0; i < 25; i++) {
      const out = translateLlmResponse(
        {
          assistantMessage: { role: 'assistant', content: '' },
          toolCalls: [],
        },
        'm',
      );
      expect(out.id).toMatch(MSG_ID_REGEX);
    }
  });

  it('stop_sequence is always null', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.stop_sequence).toBeNull();
  });

  it('reflects the requested model back verbatim', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'x' },
      toolCalls: [],
    };
    const out = translateLlmResponse(resp, 'claude-opus-4-7');
    expect(out.model).toBe('claude-opus-4-7');
  });

  it('prefers response.stopReason when provided and maps recognized values', () => {
    const resp: LlmCallResponse = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
      stopReason: 'max_tokens',
    };
    const out = translateLlmResponse(resp, 'claude-sonnet-4-6');
    expect(out.stop_reason).toBe('max_tokens');
  });
});
