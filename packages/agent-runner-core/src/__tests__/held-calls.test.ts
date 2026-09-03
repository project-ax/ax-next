import { describe, expect, it } from 'vitest';
import { createHeldCallRegistry } from '../held-calls.js';

// The registry is three lines of Set, so what these tests are really pinning
// is the LIFECYCLE: it is per-turn, and a hold from one turn must not still be
// remembered in the next (runners clear it at the turn boundary). The bleed
// case is the one that would be silent in production — a later tool result on
// a recycled id would publish the waiting-line instead of its real output,
// and nothing would throw. (Moved here from the claude-sdk runner in
// TASK-270 so both runners share one record.)
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
