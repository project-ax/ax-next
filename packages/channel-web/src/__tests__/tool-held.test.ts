import { describe, expect, it, beforeEach } from 'vitest';
import { MAX_TOOL_PHRASES } from '../lib/tool-phrase';
import {
  clearToolHeld,
  isToolHeld,
  rememberToolHeld,
} from '../lib/tool-held';

describe('tool-held display map (TASK-270)', () => {
  beforeEach(() => {
    clearToolHeld();
  });

  it('marks a held call', () => {
    rememberToolHeld('c1', true);
    expect(isToolHeld('c1')).toBe(true);
  });

  it('leaves unknown call ids unmarked', () => {
    expect(isToolHeld('unknown')).toBe(false);
  });

  it('ignores absent/false flags — a non-held frame never clears a mark', () => {
    rememberToolHeld('c1', true);
    rememberToolHeld('c1', undefined);
    rememberToolHeld('c1', false);
    rememberToolHeld('c2', undefined);
    expect(isToolHeld('c1')).toBe(true);
    expect(isToolHeld('c2')).toBe(false);
  });

  it('evicts the oldest marks past the cap (degrades to completed)', () => {
    for (let i = 0; i < MAX_TOOL_PHRASES + 5; i++) {
      rememberToolHeld(`c${i}`, true);
    }
    expect(isToolHeld('c0')).toBe(false);
    expect(isToolHeld('c4')).toBe(false);
    expect(isToolHeld(`c${MAX_TOOL_PHRASES + 4}`)).toBe(true);
  });
});
