import { describe, expect, it } from 'vitest';
import { HELD_TOOL_RESULT_TEXT } from '../held-calls.js';

// The per-turn hold record lives in `@ax/agent-runner-core` since TASK-270
// (both runners share it); its lifecycle is pinned there. This file keeps
// only the human-sentence contract.
describe('HELD_TOOL_RESULT_TEXT', () => {
  it('is the human sentence, and names nothing a layout or an id could falsify', () => {
    expect(HELD_TOOL_RESULT_TEXT).toBe(
      'Waiting for you to choose. Nothing has happened yet, and nothing will until you do.',
    );
    // No decision id, no tool name, no claim about WHERE to answer.
    expect(HELD_TOOL_RESULT_TEXT).not.toMatch(/dec_/);
    expect(HELD_TOOL_RESULT_TEXT).not.toMatch(/mcp__/);
    expect(HELD_TOOL_RESULT_TEXT).not.toMatch(/above|below|sidebar|panel/i);
  });
});
