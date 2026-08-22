import { describe, expect, it } from 'vitest';
import { HELD_TOOL_RESULT_TEXT, createHeldCallRegistry } from '../held-calls.js';

// The registry is three lines of Set, so what these tests are really pinning
// is the LIFECYCLE: it is per-turn, and a hold from one turn must not still be
// remembered in the next (main.ts clears it at the SDK `result` boundary). The
// bleed case is the one that would be silent in production — a later tool
// result on a recycled id would publish the waiting-line instead of its real
// output, and nothing would throw.
describe('createHeldCallRegistry', () => {
  it('remembers only the ids it was handed', () => {
    const held = createHeldCallRegistry();
    expect(held.has('tu_1')).toBe(false);
    held.record('tu_1');
    expect(held.has('tu_1')).toBe(true);
    expect(held.has('tu_2')).toBe(false);
  });

  it('recording the same id twice is idempotent', () => {
    const held = createHeldCallRegistry();
    held.record('tu_1');
    held.record('tu_1');
    expect(held.has('tu_1')).toBe(true);
    held.clear();
    expect(held.has('tu_1')).toBe(false);
  });

  it('clear() forgets everything — a hold must not bleed into the next turn', () => {
    const held = createHeldCallRegistry();
    held.record('tu_1');
    held.record('tu_2');
    held.clear();
    expect(held.has('tu_1')).toBe(false);
    expect(held.has('tu_2')).toBe(false);
  });
});

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
