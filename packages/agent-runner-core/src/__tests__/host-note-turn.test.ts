import { describe, it, expect } from 'vitest';
import { composeHostNoteMessage } from '../host-note-turn.js';

describe('composeHostNoteMessage', () => {
  it('frames the note as host-authored, then quotes it', () => {
    const out = composeHostNoteMessage('You are now running with services.');
    expect(out.startsWith('System message (not from the user): ')).toBe(true);
    expect(out).toContain('"You are now running with services."');
  });

  it('flattens control characters and keeps up to 4000 code points', () => {
    const out = composeHostNoteMessage('a\r\nb‮c' + 'x'.repeat(5000));
    expect(out).not.toMatch(/[\n\r‮]/);
    const quoted = JSON.parse(out.slice(out.indexOf('"'))) as string;
    expect([...quoted]).toHaveLength(4000);
    expect(quoted.endsWith('…')).toBe(true);
  });

  it('falls back to a fixed host line for a note that is empty once sanitised', () => {
    const out = composeHostNoteMessage('  \n\u200B ');
    expect(out).toContain('"AX restarted your sandbox; continue where you left off."');
  });
});
