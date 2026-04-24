import { describe, it, expect } from 'vitest';
import {
  translateAnthropicRequest,
  TranslationError,
} from '../translate-request.js';

describe('translateAnthropicRequest', () => {
  it('flattens string-content user message', () => {
    const out = translateAnthropicRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.maxTokens).toBe(1024);
  });

  it('joins multi-block text content with newline', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'a\nb' }]);
  });

  it('drops image blocks silently, keeps surrounding text', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('serializes assistant tool_use block as [tool_use <name>] <json>', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'echo ok' },
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: 'calling\n[tool_use Bash] {"command":"echo ok"}',
      },
    ]);
  });

  it('serializes user tool_result block with string content', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'result text',
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'user', content: '[tool_result tu_1] result text' },
    ]);
  });

  it('serializes tool_result with is_error=true using the [id error] qualifier', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_err',
              content: 'boom',
              is_error: true,
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'user', content: '[tool_result tu_err error] boom' },
    ]);
  });

  it('serializes tool_result with is_error=false (default) without the error qualifier', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_ok',
              content: 'ok',
              is_error: false,
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'user', content: '[tool_result tu_ok] ok' },
    ]);
  });

  it('serializes user tool_result block with block-array content', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_2',
              content: [{ type: 'text', text: 'out' }],
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'user', content: '[tool_result tu_2] out' },
    ]);
  });

  it('prepends top-level system string as the first message', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      system: 'you are a bot',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'you are a bot' },
      { role: 'user', content: 'hi' },
    ]);
  });

  // Regression: the Anthropic API accepts `system` as an array of text
  // blocks. The `claude` CLI (spawned by the claude-sdk runner) uses that
  // form exclusively. Joining with '\n' mirrors how the Anthropic server
  // concatenates blocks when building the prompt. Caught by Week 6.5d
  // Task 14 e2e.
  it('joins system as an array of {type:"text", text} blocks with newlines', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      system: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'line one\nline two' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('omits the system message when the system array is empty', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('translates tools with executesIn host sentinel', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'Bash',
          description: 'run',
          input_schema: { type: 'object' },
        },
      ],
    });
    expect(out.tools).toEqual([
      {
        name: 'Bash',
        description: 'run',
        inputSchema: { type: 'object' },
        executesIn: 'host',
      },
    ]);
  });

  it('omits tools when empty or missing', () => {
    const a = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(a.tools).toBeUndefined();

    const b = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(b.tools).toBeUndefined();
  });

  it('passes through max_tokens / temperature / model as camelCase', () => {
    const out = translateAnthropicRequest({
      model: 'claude-x',
      max_tokens: 512,
      temperature: 0.7,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.model).toBe('claude-x');
    expect(out.maxTokens).toBe(512);
    expect(out.temperature).toBe(0.7);
  });

  it('tolerates unknown top-level fields', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      metadata: { user_id: 'abc' },
      top_p: 0.9,
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('tolerates unknown fields inside content blocks', () => {
    const out = translateAnthropicRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
        },
      ],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('throws TranslationError on missing messages field', () => {
    expect(() => translateAnthropicRequest({ model: 'm', max_tokens: 10 })).toThrow(
      TranslationError,
    );
  });

  it('throws TranslationError on messages not an array', () => {
    expect(() =>
      translateAnthropicRequest({ model: 'm', max_tokens: 10, messages: 'nope' }),
    ).toThrow(TranslationError);
  });

  it('throws TranslationError on non-object root', () => {
    expect(() => translateAnthropicRequest(null)).toThrow(TranslationError);
    expect(() => translateAnthropicRequest('string')).toThrow(TranslationError);
  });

  it('TranslationError carries a readable message', () => {
    try {
      translateAnthropicRequest({ model: 'm', max_tokens: 10 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TranslationError);
      expect((e as Error).message).toMatch(/messages/i);
    }
  });

  it('rejects tool_use block on a user message', () => {
    expect(() =>
      translateAnthropicRequest({
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'Bash',
                input: { command: 'echo nope' },
              },
            ],
          },
        ],
      }),
    ).toThrow(TranslationError);
  });

  it('rejects tool_result block on an assistant message', () => {
    expect(() =>
      translateAnthropicRequest({
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: 'result text',
              },
            ],
          },
        ],
      }),
    ).toThrow(TranslationError);
  });
});
