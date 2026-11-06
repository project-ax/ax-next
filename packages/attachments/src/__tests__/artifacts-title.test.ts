import { describe, it, expect } from 'vitest';
import { normalizeArtifactTitle } from '../artifacts/title.js';

// Review Focus 5 — every invisible or bidi input below is written as a \u escape.
describe('normalizeArtifactTitle', () => {
  it('normalizeArtifactTitle strips controls, bidi and zero-width characters and keeps one line', () => {
    expect(normalizeArtifactTitle('  Deal\u000a\u000dtracker\u202e\u200b  ')).toBe('Deal tracker');
    expect(normalizeArtifactTitle('x'.repeat(201))).toBeNull();
    expect(normalizeArtifactTitle('\u200b')).toBeNull();
    expect(normalizeArtifactTitle(7)).toBeNull();
  });

  it('accepts exactly 200 code units and applies NFC first', () => {
    expect(normalizeArtifactTitle('x'.repeat(200))).toBe('x'.repeat(200));
    // e + combining acute -> one precomposed code unit.
    expect(normalizeArtifactTitle('Cafe\u0301')).toBe('Caf\u00e9');
  });

  it('turns C1 controls into spaces and drops the rest of the invisible set', () => {
    expect(normalizeArtifactTitle('a\u0085b\u009fc\u007fd')).toBe('a b c d');
    expect(normalizeArtifactTitle('\ufeffQ\u2066\u2069\u2060\u2064\u200f3')).toBe('Q3');
    expect(normalizeArtifactTitle('   ')).toBeNull();
    expect(normalizeArtifactTitle(null)).toBeNull();
  });
});
