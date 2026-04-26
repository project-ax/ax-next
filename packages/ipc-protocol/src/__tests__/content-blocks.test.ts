import { describe, expect, it } from 'vitest';
import { ContentBlockSchema } from '../content-blocks.js';

describe('ContentBlock schema', () => {
  it('parses a text block', () => {
    expect(ContentBlockSchema.parse({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
  });

  it('parses a thinking block (J4 — stored)', () => {
    expect(
      ContentBlockSchema.parse({ type: 'thinking', thinking: 'reasoning...' }),
    ).toMatchObject({ type: 'thinking' });
  });

  it('parses a thinking block with signature', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'thinking',
        thinking: 'r',
        signature: 's',
      }),
    ).toMatchObject({ type: 'thinking', signature: 's' });
  });

  it('parses a redacted_thinking block', () => {
    // Anthropic emits this when extended-thinking is flagged and the
    // cleartext is suppressed. Replay (Task 15) MUST preserve the opaque
    // `data` blob verbatim or the model detects a transcript gap.
    expect(
      ContentBlockSchema.parse({ type: 'redacted_thinking', data: 'opaque-blob' }),
    ).toMatchObject({ type: 'redacted_thinking', data: 'opaque-blob' });
  });

  it('parses a tool_use block', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_use',
        id: 'abc',
        name: 'Bash',
        input: { command: 'ls' },
      }),
    ).toMatchObject({ type: 'tool_use', id: 'abc', name: 'Bash' });
  });

  it('parses a tool_result block (string content)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: 'file1\nfile2',
      }),
    ).toMatchObject({ tool_use_id: 'abc' });
  });

  it('parses a tool_result block (array content)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: [{ type: 'text', text: 'ok' }],
      }),
    ).toMatchObject({ tool_use_id: 'abc' });
  });

  it('parses a tool_result block (is_error true)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: 'boom',
        is_error: true,
      }),
    ).toMatchObject({ tool_use_id: 'abc', is_error: true });
  });

  it('parses an image block (base64 source)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      }),
    ).toMatchObject({ type: 'image' });
  });

  it('parses an image block (url source)', () => {
    expect(
      ContentBlockSchema.parse({
        type: 'image',
        source: { type: 'url', url: 'https://example.com/img.png' },
      }),
    ).toMatchObject({ type: 'image' });
  });

  it('rejects an unknown discriminant', () => {
    expect(() => ContentBlockSchema.parse({ type: 'banana' })).toThrow();
  });

  it('rejects a thinking block missing the thinking field', () => {
    // Catches the ContentBlockShim → canonical regression: the old shim
    // accepted any object; the canonical schema requires `thinking: string`.
    expect(() =>
      ContentBlockSchema.parse({ type: 'thinking', text: 'hmm' }),
    ).toThrow();
  });
});
