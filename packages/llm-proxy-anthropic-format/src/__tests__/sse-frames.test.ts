import { describe, it, expect } from 'vitest';
import { synthesizeSseFrames } from '../sse-frames.js';
import type { AnthropicResponse } from '../anthropic-schemas.js';

interface ParsedFrame {
  event: string;
  data: unknown;
}

function parseSseFrames(raw: string): ParsedFrame[] {
  return raw
    .split('\n\n')
    .filter((s) => s.length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) {
        throw new Error(`Malformed SSE chunk: ${JSON.stringify(chunk)}`);
      }
      const event = eventLine.slice('event: '.length);
      const data = JSON.parse(dataLine.slice('data: '.length));
      return { event, data };
    });
}

function baseMessage(overrides: Partial<AnthropicResponse> = {}): AnthropicResponse {
  return {
    id: 'msg_01abc',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [],
    usage: { input_tokens: 7, output_tokens: 11 },
    ...overrides,
  };
}

describe('synthesizeSseFrames', () => {
  describe('pure text response', () => {
    const msg = baseMessage({
      content: [{ type: 'text', text: 'hello there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 42 },
    });
    const raw = synthesizeSseFrames(msg);
    const frames = parseSseFrames(raw);

    it('emits events in the required order', () => {
      expect(frames.map((f) => f.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
    });

    it('message_start carries a zeroed-content, zero-output-token message copy', () => {
      const { data } = frames[0] as { data: any };
      expect(data.type).toBe('message_start');
      expect(data.message.id).toBe('msg_01abc');
      expect(data.message.type).toBe('message');
      expect(data.message.role).toBe('assistant');
      expect(data.message.model).toBe('claude-sonnet-4-6');
      expect(data.message.content).toEqual([]);
      expect(data.message.stop_reason).toBeNull();
      expect(data.message.stop_sequence).toBeNull();
      expect(data.message.usage.input_tokens).toBe(5);
      expect(data.message.usage.output_tokens).toBe(0);
    });

    it('emits a single text_delta with the full text', () => {
      const start = frames[1] as { data: any };
      const delta = frames[2] as { data: any };
      const stop = frames[3] as { data: any };

      expect(start.data).toEqual({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      expect(delta.data).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello there' },
      });
      expect(stop.data).toEqual({
        type: 'content_block_stop',
        index: 0,
      });
    });

    it('message_delta reflects final stop_reason and output_tokens', () => {
      const { data } = frames[4] as { data: any };
      expect(data.type).toBe('message_delta');
      expect(data.delta.stop_reason).toBe('end_turn');
      expect(data.delta.stop_sequence).toBeNull();
      expect(data.usage.output_tokens).toBe(42);
    });

    it('message_stop is the final frame', () => {
      const { data } = frames[5] as { data: any };
      expect(data).toEqual({ type: 'message_stop' });
    });

    it('does not mutate the input message', () => {
      const input = baseMessage({
        content: [{ type: 'text', text: 'keep me' }],
        usage: { input_tokens: 5, output_tokens: 42 },
      });
      const snapshot = JSON.parse(JSON.stringify(input));
      synthesizeSseFrames(input);
      expect(input).toEqual(snapshot);
    });
  });

  describe('text + tool_use response', () => {
    const msg = baseMessage({
      content: [
        { type: 'text', text: 'running it' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'Bash',
          input: { command: 'echo ok', timeout: 5 },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 3 },
    });
    const frames = parseSseFrames(synthesizeSseFrames(msg));

    it('emits two block start/delta/stop triplets with indices 0 and 1', () => {
      expect(frames.map((f) => f.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect((frames[1].data as any).index).toBe(0);
      expect((frames[2].data as any).index).toBe(0);
      expect((frames[3].data as any).index).toBe(0);
      expect((frames[4].data as any).index).toBe(1);
      expect((frames[5].data as any).index).toBe(1);
      expect((frames[6].data as any).index).toBe(1);
    });

    it('tool_use content_block_start has empty {} input', () => {
      const toolStart = frames[4].data as any;
      expect(toolStart.content_block).toEqual({
        type: 'tool_use',
        id: 'tu_1',
        name: 'Bash',
        input: {},
      });
    });

    it('tool_use delta carries input_json_delta with stringified input', () => {
      const toolDelta = frames[5].data as any;
      expect(toolDelta.delta.type).toBe('input_json_delta');
      expect(toolDelta.delta.partial_json).toBe(
        JSON.stringify({ command: 'echo ok', timeout: 5 }),
      );
    });

    it('final message_delta carries tool_use stop_reason', () => {
      const final = frames[7].data as any;
      expect(final.delta.stop_reason).toBe('tool_use');
      expect(final.usage.output_tokens).toBe(3);
    });
  });

  describe('tool_use-only response', () => {
    const msg = baseMessage({
      content: [
        {
          type: 'tool_use',
          id: 'tu_7',
          name: 'Read',
          input: { path: '/tmp/x' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const frames = parseSseFrames(synthesizeSseFrames(msg));

    it('emits no text block frames', () => {
      expect(frames.map((f) => f.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
    });

    it('has the single tool_use block at index 0', () => {
      const start = frames[1].data as any;
      expect(start.index).toBe(0);
      expect(start.content_block.type).toBe('tool_use');
      expect(start.content_block.id).toBe('tu_7');
      expect(start.content_block.name).toBe('Read');
      expect(start.content_block.input).toEqual({});

      const delta = frames[2].data as any;
      expect(delta.index).toBe(0);
      expect(delta.delta.type).toBe('input_json_delta');
      expect(delta.delta.partial_json).toBe(JSON.stringify({ path: '/tmp/x' }));

      const stop = frames[3].data as any;
      expect(stop).toEqual({ type: 'content_block_stop', index: 0 });
    });
  });

  describe('empty content response', () => {
    const msg = baseMessage({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 0 },
    });
    const frames = parseSseFrames(synthesizeSseFrames(msg));

    it('emits only message_start, message_delta, message_stop', () => {
      expect(frames.map((f) => f.event)).toEqual([
        'message_start',
        'message_delta',
        'message_stop',
      ]);
    });
  });

  describe('SSE format correctness', () => {
    const msg = baseMessage({
      content: [{ type: 'text', text: 'x' }],
    });
    const raw = synthesizeSseFrames(msg);

    it('every frame starts with "event: " and contains a "data: " line', () => {
      const chunks = raw.split('\n\n').filter((s) => s.length > 0);
      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        expect(lines[0].startsWith('event: ')).toBe(true);
        expect(lines.some((l) => l.startsWith('data: '))).toBe(true);
      }
    });

    it('every data line is a single line of valid JSON', () => {
      const chunks = raw.split('\n\n').filter((s) => s.length > 0);
      for (const chunk of chunks) {
        const dataLine = chunk
          .split('\n')
          .find((l) => l.startsWith('data: '))!;
        const payload = dataLine.slice('data: '.length);
        expect(payload).not.toContain('\n');
        expect(() => JSON.parse(payload)).not.toThrow();
      }
    });

    it('ends with \\n\\n exactly once (no trailing whitespace past the terminator)', () => {
      expect(raw.endsWith('\n\n')).toBe(true);
      expect(raw.endsWith('\n\n\n')).toBe(false);
      expect(raw.endsWith(' \n\n')).toBe(false);
    });

    it('each frame ends with \\n\\n (verified by split invariant)', () => {
      const reassembled = raw
        .split('\n\n')
        .filter((s) => s.length > 0)
        .map((chunk) => `${chunk}\n\n`)
        .join('');
      expect(reassembled).toBe(raw);
    });
  });

  describe('special-character escaping', () => {
    it('escapes embedded newlines inside text_delta per JSON rules', () => {
      const msg = baseMessage({
        content: [{ type: 'text', text: 'hello\nworld' }],
      });
      const raw = synthesizeSseFrames(msg);
      const frames = parseSseFrames(raw);
      const delta = frames.find((f) => f.event === 'content_block_delta')!
        .data as any;
      expect(delta.delta.type).toBe('text_delta');
      expect(delta.delta.text).toBe('hello\nworld');
    });

    it('escapes quotes and backslashes inside text_delta', () => {
      const tricky = 'she said "hi" \\ then left';
      const msg = baseMessage({
        content: [{ type: 'text', text: tricky }],
      });
      const frames = parseSseFrames(synthesizeSseFrames(msg));
      const delta = frames.find((f) => f.event === 'content_block_delta')!
        .data as any;
      expect(delta.delta.text).toBe(tricky);
    });

    it('tool_use input_json_delta stringifies the full input including nested objects', () => {
      const input = {
        path: '/x',
        flags: ['-f', '-r'],
        meta: { nested: { deep: true, line: 'a\nb' } },
      };
      const msg = baseMessage({
        content: [
          { type: 'tool_use', id: 'tu_9', name: 'Write', input },
        ],
        stop_reason: 'tool_use',
      });
      const frames = parseSseFrames(synthesizeSseFrames(msg));
      const delta = frames.find((f) => f.event === 'content_block_delta')!
        .data as any;
      expect(delta.delta.partial_json).toBe(JSON.stringify(input));
      expect(JSON.parse(delta.delta.partial_json)).toEqual(input);
    });
  });
});
