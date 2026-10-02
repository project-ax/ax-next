import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENT_NAME, oauthClientName } from '../client-name.js';

describe('oauthClientName', () => {
  it('uses the branded name as given', () => {
    expect(oauthClientName('Canopy AI')).toBe('Canopy AI');
  });

  it.each([null, undefined, '', '   ', '\u0000‮'])('falls back to AX for %j', (raw) => {
    expect(oauthClientName(raw)).toBe(DEFAULT_CLIENT_NAME);
  });

  it('strips control and bidi-override characters that could reorder consent text', () => {
    expect(oauthClientName('Can‮opy\u0007 AI')).toBe('Canopy AI');
    expect(oauthClientName('Line break')).toBe('Linebreak');
  });

  it('collapses whitespace and caps the length by characters, not UTF-16 units', () => {
    expect(oauthClientName('  Canopy \n\t AI  ')).toBe('Canopy AI');
    expect(oauthClientName('🌳'.repeat(80))).toBe('🌳'.repeat(64));
  });
});
