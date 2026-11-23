import { describe, expect, it } from 'vitest';
import { keepSlashAsText, SLASH_TEXT_GUARD } from '../slash-text.js';

// TASK-1217: a turn's text that starts with `/` would reach the CLI's own
// command processor (expand a bundled skill with no `Skill` call, `/clear` the
// session, swallow an unknown word). `keepSlashAsText` puts an invisible
// U+200B in front of it so the CLI reads it as words.

describe('SLASH_TEXT_GUARD', () => {
  it('is U+200B ZERO WIDTH SPACE, which trim() keeps', () => {
    expect(SLASH_TEXT_GUARD).toBe('​');
    // The CLI's queued-message path trims before it looks for `/`. A guard
    // that trim() removed would be no guard at all.
    expect(`${SLASH_TEXT_GUARD}/clear`.trim().startsWith('/')).toBe(false);
    expect(`${SLASH_TEXT_GUARD}  /clear`.trim().startsWith('/')).toBe(false);
  });
});

describe('keepSlashAsText', () => {
  it('guards a string that starts with a slash', () => {
    expect(keepSlashAsText('/clear')).toBe('​/clear');
    expect(keepSlashAsText('/update-config add a hook please')).toBe('​/update-config add a hook please');
    expect(keepSlashAsText('/')).toBe('​/');
  });

  it('guards a string whose first non-space character is a slash, in front of the spaces', () => {
    // A leading space alone is not enough: the CLI's queued path trims it off.
    expect(keepSlashAsText('  /compact')).toBe('​  /compact');
    expect(keepSlashAsText('\n\t/clear')).toBe('​\n\t/clear');
    // trim() treats U+FEFF as whitespace, so the CLI would too.
    expect(keepSlashAsText('﻿/clear')).toBe('​﻿/clear');
  });

  it('returns the same string when it does not start with a slash', () => {
    for (const text of ['hello /x', '', '   ', 'hello', '!touch /tmp/x', '#remember this', '​/clear']) {
      expect(keepSlashAsText(text), JSON.stringify(text)).toBe(text);
    }
  });

  it('guards each text block of an array that starts with a slash, and only those', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const input = [
      { type: 'text', text: '/a' },
      image,
      { type: 'text', text: 'b' },
      { type: 'text', text: ' /c', cache_control: { type: 'ephemeral' } },
    ];
    const before = structuredClone(input);

    const out = keepSlashAsText(input) as typeof input;

    expect(out).toEqual([
      { type: 'text', text: '​/a' },
      image,
      { type: 'text', text: 'b' },
      { type: 'text', text: '​ /c', cache_control: { type: 'ephemeral' } },
    ]);
    // Never mutates its input: not the array, not a block.
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    // Blocks it did not change are passed through as they were.
    expect(out[1]).toBe(image);
    expect(out[2]).toBe(input[2]);
  });

  it('returns the same array when no text block starts with a slash', () => {
    const input = [
      { type: 'text', text: 'System message (not from the user): network egress is now ALLOWED.' },
      { type: 'text', text: "User attached 'a.csv' at /tmp/uploads/a.csv (text/csv)" },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ];
    expect(keepSlashAsText(input)).toBe(input);
    expect(keepSlashAsText([])).toEqual([]);
  });

  it('guards the person\'s text after a leading system line, the shape a turn with an allowed host takes', () => {
    // The CLI reads the LAST text block of an array as the command text, so a
    // slash block after another text block still counts.
    const input = [
      { type: 'text', text: 'System message (not from the user): network egress is now ALLOWED.' },
      { type: 'text', text: '/clear' },
    ];
    expect(keepSlashAsText(input)).toEqual([input[0], { type: 'text', text: '​/clear' }]);
  });

  it('leaves a block whose text is not a string, and anything that is not a block, alone', () => {
    const odd = [{ type: 'text', text: 42 }, { type: 'text' }, null, 'raw', { type: 'image', text: '/x' }];
    expect(keepSlashAsText(odd)).toBe(odd);
  });

  it('returns anything that is neither a string nor an array as is', () => {
    const obj = {};
    expect(keepSlashAsText(null)).toBeNull();
    expect(keepSlashAsText(undefined)).toBeUndefined();
    expect(keepSlashAsText(42)).toBe(42);
    expect(keepSlashAsText(obj)).toBe(obj);
  });
});
