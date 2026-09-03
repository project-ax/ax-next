import { describe, expect, it } from 'vitest';
import { ToolResultBlockSchema } from '../content-blocks.js';
import { EventStreamChunkSchema } from '../events.js';

describe('held flag on the tool-result wire shape (TASK-270)', () => {
  it('tool_result block preserves a present flag', () => {
    const parsed = ToolResultBlockSchema.parse({
      type: 'tool_result',
      tool_use_id: 'u1',
      content: 'Waiting for you to choose.',
      held: true,
    });
    expect(parsed.held).toBe(true);
  });

  it('tool_result block without the flag parses as before (backward compat)', () => {
    const parsed = ToolResultBlockSchema.parse({
      type: 'tool_result',
      tool_use_id: 'u1',
      content: 'ok',
    });
    expect(parsed.held).toBeUndefined();
    expect(parsed.is_error).toBeUndefined();
  });

  it('tool_result block still carries is_error alongside the flag shape', () => {
    const parsed = ToolResultBlockSchema.parse({
      type: 'tool_result',
      tool_use_id: 'u1',
      content: 'boom',
      is_error: true,
    });
    expect(parsed.is_error).toBe(true);
    expect(parsed.held).toBeUndefined();
  });

  it('stream-chunk tool-result preserves a present flag', () => {
    const parsed = EventStreamChunkSchema.parse({
      reqId: 'r1',
      kind: 'tool-result',
      toolCallId: 'c1',
      output: 'Waiting for you to choose.',
      held: true,
    });
    expect(parsed.kind).toBe('tool-result');
    if (parsed.kind === 'tool-result') {
      expect(parsed.held).toBe(true);
    }
  });

  it('stream-chunk tool-result without the flag parses as before', () => {
    const parsed = EventStreamChunkSchema.parse({
      reqId: 'r1',
      kind: 'tool-result',
      toolCallId: 'c1',
      output: 'ok',
    });
    if (parsed.kind === 'tool-result') {
      expect(parsed.held).toBeUndefined();
    } else {
      expect.unreachable();
    }
  });
});
