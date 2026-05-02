import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseJsonlToTurns, type ParsedTurn } from '../parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

async function readFixture(name: string): Promise<Uint8Array> {
  const buf = await readFile(join(FIXTURES, name));
  return new Uint8Array(buf);
}

function expectIndicesAreSequential(turns: ParsedTurn[]): void {
  for (let i = 0; i < turns.length; i++) {
    expect(turns[i].turnIndex).toBe(i);
  }
}

function expectAllShapeInvariants(turns: ParsedTurn[]): void {
  for (const t of turns) {
    expect(typeof t.turnId).toBe('string');
    expect(t.turnId.length).toBeGreaterThan(0);
    expect(typeof t.createdAt).toBe('string');
    expect(t.createdAt).toMatch(ISO_8601_RE);
    expect(['user', 'assistant', 'tool']).toContain(t.role);
    expect(Array.isArray(t.contentBlocks)).toBe(true);
  }
  expectIndicesAreSequential(turns);
}

describe('parseJsonlToTurns', () => {
  it('parses a simple two-turn fixture (user string + assistant text)', async () => {
    const bytes = await readFixture('simple.jsonl');
    const turns = parseJsonlToTurns(bytes);

    expect(turns).toHaveLength(2);
    expectAllShapeInvariants(turns);

    expect(turns[0]).toEqual({
      turnId: '03672f80-b371-45f9-b041-104bf4963ec8',
      turnIndex: 0,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'please run echo' }],
      createdAt: '2026-04-24T19:37:00.381Z',
    });

    expect(turns[1]).toEqual({
      turnId: 'cf62f477-7393-4161-9eee-65f9a227cd6b',
      turnIndex: 1,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'running bash' }],
      createdAt: '2026-04-24T19:37:00.394Z',
    });
  });

  it('preserves thinking + redacted_thinking + text blocks verbatim', async () => {
    const bytes = await readFixture('with-thinking.jsonl');
    const turns = parseJsonlToTurns(bytes);

    expect(turns).toHaveLength(2);
    expectAllShapeInvariants(turns);

    const assistant = turns[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.contentBlocks).toEqual([
      { type: 'thinking', thinking: 'hmm, let me think', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'opaque-blob-xyz' },
      { type: 'text', text: 'here is my answer' },
    ]);
  });

  it('coalesces consecutive assistant lines sharing message.id and emits tool_result with role=tool', async () => {
    const bytes = await readFixture('with-tool-use.jsonl');
    const turns = parseJsonlToTurns(bytes);

    // The realistic SDK shape splits a single logical assistant message
    // into two consecutive jsonl lines (text first, tool_use second) with
    // the same message.id. We coalesce them back into one Turn.
    expect(turns).toHaveLength(3);
    expectAllShapeInvariants(turns);

    expect(turns[0].role).toBe('user');
    expect(turns[0].contentBlocks).toEqual([
      { type: 'text', text: 'please run echo then check' },
    ]);

    // Coalesced assistant Turn — keeps the FIRST line's uuid + timestamp.
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].turnId).toBe('a-bbb-bbb-bbb-bbb-bbbbbbbbbbbb');
    expect(turns[1].createdAt).toBe('2026-04-24T19:37:00.394Z');
    expect(turns[1].contentBlocks).toEqual([
      { type: 'text', text: 'running bash' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } },
    ]);

    // tool_result wrapped inside a user message — role becomes 'tool' so
    // the channel-web history-adapter routes it into the assistant lane.
    expect(turns[2].role).toBe('tool');
    expect(turns[2].contentBlocks).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'hi',
        is_error: false,
      },
    ]);
  });

  it('returns [] on empty / whitespace-only input', async () => {
    const bytes = await readFixture('empty.jsonl');
    expect(parseJsonlToTurns(bytes)).toEqual([]);
  });

  it('returns [] when only system metadata lines are present', async () => {
    const bytes = await readFixture('system-only.jsonl');
    expect(parseJsonlToTurns(bytes)).toEqual([]);
  });

  it('skips a truncated final line and returns whatever could parse', async () => {
    const bytes = await readFixture('truncated.jsonl');
    const turns = parseJsonlToTurns(bytes);

    expect(turns).toHaveLength(1);
    expectAllShapeInvariants(turns);
    expect(turns[0].role).toBe('user');
    expect(turns[0].contentBlocks).toEqual([
      { type: 'text', text: 'please run echo' },
    ]);
  });

  it('skips a mid-file invalid-JSON line and emits the bracketing valid turns', async () => {
    const bytes = await readFixture('mid-corrupt.jsonl');
    const turns = parseJsonlToTurns(bytes);

    expect(turns).toHaveLength(2);
    expectAllShapeInvariants(turns);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[1].turnIndex).toBe(1);
  });

  it('skips blank lines in the middle of the file (no turn emitted, no index bump)', () => {
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'one' },
        uuid: 'u-1',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      '',
      '   ',
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_a',
          role: 'assistant',
          content: [{ type: 'text', text: 'two' }],
        },
        uuid: 'a-2',
        timestamp: '2026-04-24T19:37:01.000Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[1].turnIndex).toBe(1);
    expect(turns[0].turnId).toBe('u-1');
    expect(turns[1].turnId).toBe('a-2');
  });

  it('drops blocks that fail ContentBlockSchema but still emits the turn with surviving blocks', () => {
    const enc = new TextEncoder();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_future',
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          // a future SDK block type the canonical schema doesn't know about:
          { type: 'mystery_future_block', data: 'whatever' },
          { type: 'text', text: 'world' },
        ],
      },
      uuid: 'a-future',
      timestamp: '2026-04-24T19:37:00.000Z',
    });
    const bytes = enc.encode(line + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].contentBlocks).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('skips a turn-bearing line whose contentBlocks ends up empty after validation', () => {
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'kept' },
        uuid: 'u-kept',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_empty',
          role: 'assistant',
          content: [{ type: 'mystery_future_block', data: 'x' }],
        },
        uuid: 'a-empty',
        timestamp: '2026-04-24T19:37:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_after',
          role: 'assistant',
          content: [{ type: 'text', text: 'after' }],
        },
        uuid: 'a-after',
        timestamp: '2026-04-24T19:37:02.000Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBe('u-kept');
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[1].turnId).toBe('a-after');
    expect(turns[1].turnIndex).toBe(1);
  });

  it('skips a line missing uuid or timestamp', () => {
    const enc = new TextEncoder();
    const lines = [
      // missing uuid
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'no uuid' },
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      // missing timestamp
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'no timestamp' },
        uuid: 'u-no-ts',
      }),
      // valid
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'good' },
        uuid: 'u-good',
        timestamp: '2026-04-24T19:37:02.000Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe('u-good');
    expect(turns[0].turnIndex).toBe(0);
  });

  it('does not throw on complete garbage input', () => {
    const bytes = new TextEncoder().encode('not json at all\n{also not\nlol\n');
    expect(() => parseJsonlToTurns(bytes)).not.toThrow();
    expect(parseJsonlToTurns(bytes)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Role-mapping / coalescing edge cases
  // ---------------------------------------------------------------------

  it('user line with string content → role=user with a single text block', () => {
    const enc = new TextEncoder();
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello there' },
      uuid: 'u-string',
      timestamp: '2026-04-24T19:37:00.000Z',
    });
    const bytes = enc.encode(line + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].contentBlocks).toEqual([
      { type: 'text', text: 'hello there' },
    ]);
  });

  it('user line whose array content is all tool_result → role=tool', () => {
    const enc = new TextEncoder();
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_x',
            content: 'ok',
            is_error: false,
          },
        ],
      },
      uuid: 'u-toolresult',
      timestamp: '2026-04-24T19:37:00.000Z',
    });
    const bytes = enc.encode(line + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('tool');
    expect(turns[0].contentBlocks[0]?.type).toBe('tool_result');
  });

  it('user line with array content of all text/image blocks → role=user', () => {
    // An SDK caller can feed the input message as an array of blocks
    // (e.g. attaching an image). Preserve role='user' so the user lane
    // renders correctly.
    const enc = new TextEncoder();
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
      uuid: 'u-img',
      timestamp: '2026-04-24T19:37:00.000Z',
    });
    const bytes = enc.encode(line + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].contentBlocks).toHaveLength(2);
    expect(turns[0].contentBlocks[0]?.type).toBe('text');
    expect(turns[0].contentBlocks[1]?.type).toBe('image');
  });

  it('user line with mixed tool_result + text → role=tool (any tool_result wins)', () => {
    const enc = new TextEncoder();
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'here is the result:' },
          {
            type: 'tool_result',
            tool_use_id: 'tu_z',
            content: 'ok',
            is_error: false,
          },
        ],
      },
      uuid: 'u-mixed',
      timestamp: '2026-04-24T19:37:00.000Z',
    });
    const bytes = enc.encode(line + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('tool');
    expect(turns[0].contentBlocks).toHaveLength(2);
  });

  it('two consecutive assistant lines with the SAME message.id → coalesced', () => {
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_same',
          role: 'assistant',
          content: [{ type: 'text', text: 'part one' }],
        },
        uuid: 'a-1',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_same',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
          ],
        },
        uuid: 'a-2',
        timestamp: '2026-04-24T19:37:00.001Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].turnId).toBe('a-1');
    expect(turns[0].createdAt).toBe('2026-04-24T19:37:00.000Z');
    expect(turns[0].contentBlocks).toEqual([
      { type: 'text', text: 'part one' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
    ]);
  });

  it('two consecutive assistant lines with DIFFERENT message.id → separate Turns', () => {
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_one',
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
        uuid: 'a-1',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_two',
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
        uuid: 'a-2',
        timestamp: '2026-04-24T19:37:00.001Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBe('a-1');
    expect(turns[1].turnId).toBe('a-2');
  });

  it('a non-assistant Turn between two same-id assistant lines breaks the streak', () => {
    // Defensive: even if a later assistant line shares the prior assistant's
    // message.id, a tool/user Turn between them prevents coalescing.
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_repeat',
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
        uuid: 'a-1',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
        uuid: 'u-mid',
        timestamp: '2026-04-24T19:37:00.500Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_repeat',
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
        uuid: 'a-2',
        timestamp: '2026-04-24T19:37:01.000Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(3);
    expect(turns[0].role).toBe('assistant');
    expect(turns[1].role).toBe('tool');
    expect(turns[2].role).toBe('assistant');
    expect(turns[0].turnId).toBe('a-1');
    expect(turns[2].turnId).toBe('a-2');
  });

  it('a blank or corrupt line between same-id assistant lines does NOT break the streak', () => {
    // Nothing was emitted between the two assistants, so coalescing still
    // applies — easier to reason about than tracking "lines seen".
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_same',
          role: 'assistant',
          content: [{ type: 'text', text: 'part one' }],
        },
        uuid: 'a-1',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      '',
      '{not valid json,,,',
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_same',
          role: 'assistant',
          content: [{ type: 'text', text: 'part two' }],
        },
        uuid: 'a-2',
        timestamp: '2026-04-24T19:37:00.001Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(1);
    expect(turns[0].turnId).toBe('a-1');
    expect(turns[0].contentBlocks).toEqual([
      { type: 'text', text: 'part one' },
      { type: 'text', text: 'part two' },
    ]);
  });

  it('an assistant line with no message.id is treated as a new Turn (no coalesce)', () => {
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_one',
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
        uuid: 'a-1',
        timestamp: '2026-04-24T19:37:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          // no id field
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
        uuid: 'a-2',
        timestamp: '2026-04-24T19:37:00.001Z',
      }),
    ];
    const bytes = enc.encode(lines.join('\n') + '\n');

    const turns = parseJsonlToTurns(bytes);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBe('a-1');
    expect(turns[1].turnId).toBe('a-2');
  });
});
