import { describe, expect, it } from 'vitest';
import { CHILD_FRAME_TAGS, DSD_ATTRS, FRAME_GUARD_SOURCE, MAX_PREPARED_BYTES } from '../index.js';

describe('@ax/frame-guard', () => {
  it('exposes the guard source as a non-empty string', () => {
    expect(typeof FRAME_GUARD_SOURCE).toBe('string');
    expect(FRAME_GUARD_SOURCE.trim().length).toBeGreaterThan(0);
  });

  it('keeps the guard source safe to inline in a <script> element', () => {
    // A script-closing tag would end the element early; an HTML comment
    // opener changes how the tokenizer treats the rest of the script.
    expect(FRAME_GUARD_SOURCE.toLowerCase()).not.toContain('</script');
    expect(FRAME_GUARD_SOURCE).not.toContain('<!--');
  });

  it('exposes the most a prepared page may be, in bytes, for the cache of whatever serves it', () => {
    // Twice the largest page there can be as input (4 MiB): the origin keeps room for four of them.
    expect(MAX_PREPARED_BYTES).toBe(8 * 1024 * 1024);
  });

  it('exposes non-empty constant lists', () => {
    expect(CHILD_FRAME_TAGS.length).toBeGreaterThan(0);
    expect(DSD_ATTRS.length).toBeGreaterThan(0);
    for (const t of [...CHILD_FRAME_TAGS, ...DSD_ATTRS]) {
      expect(t).toMatch(/^[a-z]+$/);
    }
  });
});
