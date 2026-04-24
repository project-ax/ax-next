import { describe, it, expect } from 'vitest';
import { synthesizeSseFrames } from '../sse-frames.js';
import type { AnthropicResponse } from '../anthropic-schemas.js';

// Typed view of the frames we synthesize. Keeps the test file `any`-free while
// still letting individual cases narrow by `event`. We model only the fields
// the tests read — upstream Anthropic frame schemas are far richer, but the
// narrowed shape below is sufficient for these expectations.

interface MessageStartData {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: unknown[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

interface TextContentBlock {
  type: 'text';
  text: string;
}

interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

type StartContentBlock = TextContentBlock | ToolUseContentBlock;

interface ContentBlockStartData {
  type: 'content_block_start';
  index: number;
  content_block: StartContentBlock;
}

interface TextDelta {
  type: 'text_delta';
  text: string;
}

interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

interface ContentBlockDeltaData {
  type: 'content_block_delta';
  index: number;
  delta: TextDelta | InputJsonDelta;
}

interface ContentBlockStopData {
  type: 'content_block_stop';
  index: number;
}

interface MessageDeltaData {
  type: 'message_delta';
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

interface MessageStopData {
  type: 'message_stop';
}

type ParsedFrame =
  | { event: 'message_start'; data: MessageStartData }
  | { event: 'content_block_start'; data: ContentBlockStartData }
  | { event: 'content_block_delta'; data: ContentBlockDeltaData }
  | { event: 'content_block_stop'; data: ContentBlockStopData }
  | { event: 'message_delta'; data: MessageDeltaData }
  | { event: 'message_stop'; data: MessageStopData };

function parseSseFrames(raw: string): ParsedFrame[] {
  return raw
    .split('\n\n')
    .filter((s) => s.length > 0)
    .map((chunk): ParsedFrame => {
      const lines = chunk.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) {
        throw new Error(`Malformed SSE chunk: ${JSON.stringify(chunk)}`);
      }
      const event = eventLine.slice('event: '.length);
      const data: unknown = JSON.parse(dataLine.slice('data: '.length));
      // The synthesizer is the only producer, so each (event, data.type)
      // pairing is known. We trust the shape here — the translator + schema
      // tests cover the producing side.
      return { event, data } as ParsedFrame;
    });
}

function expectFrame<E extends ParsedFrame['event']>(
  frame: ParsedFrame,
  event: E,
): Extract<ParsedFrame, { event: E }> {
  if (frame.event !== event) {
    throw new Error(`expected frame event '${event}', got '${frame.event}'`);
  }
  return frame as Extract<ParsedFrame, { event: E }>;
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
      const { data } = expectFrame(frames[0], 'message_start');
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
      const start = expectFrame(frames[1], 'content_block_start');
      const delta = expectFrame(frames[2], 'content_block_delta');
      const stop = expectFrame(frames[3], 'content_block_stop');

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
      const { data } = expectFrame(frames[4], 'message_delta');
      expect(data.type).toBe('message_delta');
      expect(data.delta.stop_reason).toBe('end_turn');
      expect(data.delta.stop_sequence).toBeNull();
      expect(data.usage.output_tokens).toBe(42);
    });

    it('message_stop is the final frame', () => {
      const { data } = expectFrame(frames[5], 'message_stop');
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
      expect(expectFrame(frames[1], 'content_block_start').data.index).toBe(0);
      expect(expectFrame(frames[2], 'content_block_delta').data.index).toBe(0);
      expect(expectFrame(frames[3], 'content_block_stop').data.index).toBe(0);
      expect(expectFrame(frames[4], 'content_block_start').data.index).toBe(1);
      expect(expectFrame(frames[5], 'content_block_delta').data.index).toBe(1);
      expect(expectFrame(frames[6], 'content_block_stop').data.index).toBe(1);
    });

    it('tool_use content_block_start has empty {} input', () => {
      const toolStart = expectFrame(frames[4], 'content_block_start').data;
      expect(toolStart.content_block).toEqual({
        type: 'tool_use',
        id: 'tu_1',
        name: 'Bash',
        input: {},
      });
    });

    it('tool_use delta carries input_json_delta with stringified input', () => {
      const toolDelta = expectFrame(frames[5], 'content_block_delta').data;
      expect(toolDelta.delta.type).toBe('input_json_delta');
      if (toolDelta.delta.type !== 'input_json_delta') throw new Error('narrowing');
      expect(toolDelta.delta.partial_json).toBe(
        JSON.stringify({ command: 'echo ok', timeout: 5 }),
      );
    });

    it('final message_delta carries tool_use stop_reason', () => {
      const final = expectFrame(frames[7], 'message_delta').data;
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
      const start = expectFrame(frames[1], 'content_block_start').data;
      expect(start.index).toBe(0);
      expect(start.content_block.type).toBe('tool_use');
      if (start.content_block.type !== 'tool_use') throw new Error('narrowing');
      expect(start.content_block.id).toBe('tu_7');
      expect(start.content_block.name).toBe('Read');
      expect(start.content_block.input).toEqual({});

      const delta = expectFrame(frames[2], 'content_block_delta').data;
      expect(delta.index).toBe(0);
      expect(delta.delta.type).toBe('input_json_delta');
      if (delta.delta.type !== 'input_json_delta') throw new Error('narrowing');
      expect(delta.delta.partial_json).toBe(JSON.stringify({ path: '/tmp/x' }));

      const stop = expectFrame(frames[3], 'content_block_stop').data;
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
      const deltaFrame = frames.find(
        (f): f is Extract<ParsedFrame, { event: 'content_block_delta' }> =>
          f.event === 'content_block_delta',
      )!;
      expect(deltaFrame.data.delta.type).toBe('text_delta');
      if (deltaFrame.data.delta.type !== 'text_delta') throw new Error('narrowing');
      expect(deltaFrame.data.delta.text).toBe('hello\nworld');
    });

    it('escapes quotes and backslashes inside text_delta', () => {
      const tricky = 'she said "hi" \\ then left';
      const msg = baseMessage({
        content: [{ type: 'text', text: tricky }],
      });
      const frames = parseSseFrames(synthesizeSseFrames(msg));
      const deltaFrame = frames.find(
        (f): f is Extract<ParsedFrame, { event: 'content_block_delta' }> =>
          f.event === 'content_block_delta',
      )!;
      if (deltaFrame.data.delta.type !== 'text_delta') throw new Error('narrowing');
      expect(deltaFrame.data.delta.text).toBe(tricky);
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
      const deltaFrame = frames.find(
        (f): f is Extract<ParsedFrame, { event: 'content_block_delta' }> =>
          f.event === 'content_block_delta',
      )!;
      if (deltaFrame.data.delta.type !== 'input_json_delta') throw new Error('narrowing');
      expect(deltaFrame.data.delta.partial_json).toBe(JSON.stringify(input));
      expect(JSON.parse(deltaFrame.data.delta.partial_json)).toEqual(input);
    });
  });
});
