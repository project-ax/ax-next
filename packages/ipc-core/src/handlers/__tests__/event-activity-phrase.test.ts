import { describe, expect, it } from 'vitest';
import { validateEventStreamChunk } from '../event-stream-chunk.js';
import { validateEventTurnEnd } from '../event-turn-end.js';

describe('activityPhrase fencing at the IPC ingress (TASK-271)', () => {
  it('stream-chunk: passes a clean phrase through and keeps the chunk', () => {
    const out = validateEventStreamChunk({
      reqId: 'r1',
      kind: 'tool-use',
      toolCallId: 'c1',
      toolName: 'memory_search',
      input: { query: 'x' },
      activityPhrase: 'Searching memory',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload).toMatchObject({
        kind: 'tool-use',
        toolName: 'memory_search',
        activityPhrase: 'Searching memory',
      });
    }
  });

  it('stream-chunk: mangles a hostile phrase but keeps the chunk', () => {
    const out = validateEventStreamChunk({
      reqId: 'r1',
      kind: 'tool-use',
      toolCallId: 'c1',
      toolName: 'Bash',
      input: {},
      activityPhrase: 'Reading email\n"; rm -rf ~; echo "',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.kind).toBe('tool-use');
      if (out.payload.kind === 'tool-use') {
        // Single line: the injected second line is gone, the chunk survives.
        expect(out.payload.activityPhrase).toBe('Reading email');
        expect(out.payload.toolName).toBe('Bash');
      }
    }
  });

  it('stream-chunk: drops an unsalvageable phrase instead of the chunk', () => {
    const out = validateEventStreamChunk({
      reqId: 'r1',
      kind: 'tool-use',
      toolCallId: 'c1',
      toolName: 'Bash',
      input: {},
      activityPhrase: '   ',
    });
    expect(out.ok).toBe(true);
    if (out.ok && out.payload.kind === 'tool-use') {
      expect('activityPhrase' in out.payload).toBe(false);
    } else {
      expect.unreachable();
    }
  });

  it('turn-end: sanitizes tool_use phrases in persisted blocks', () => {
    const out = validateEventTurnEnd({
      reason: 'complete',
      role: 'assistant',
      contentBlocks: [
        { type: 'text', text: 'hi' },
        {
          type: 'tool_use',
          id: 'u1',
          name: 'memory_search',
          input: {},
          activityPhrase: 'Searching memory\ninjected',
        },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.contentBlocks).toMatchObject([
        { type: 'text' },
        { type: 'tool_use', activityPhrase: 'Searching memory' },
      ]);
    }
  });

  it('turn-end: blocks without phrases pass through untouched', () => {
    const out = validateEventTurnEnd({
      reason: 'complete',
      role: 'assistant',
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'u1',
          name: 'Bash',
          input: {},
        },
      ],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.contentBlocks).toEqual([
        { type: 'tool_use', id: 'u1', name: 'Bash', input: {} },
      ]);
    }
  });
});
