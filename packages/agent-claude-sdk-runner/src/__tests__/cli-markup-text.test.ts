import { describe, expect, it } from 'vitest';
import { CLI_MARKUP_GUARD as G, CLI_MARKUP_TAGS, keepCliMarkupAsText } from '../cli-markup-text.js';

// TASK-1220: the CLI reads `@<path>` files before the model call (no
// PreToolUse) and treats its own markup tags as its own messages. The guard
// is an invisible U+200B in the CLI's copy only.

describe('keepCliMarkupAsText: @ mentions', () => {
  it('guards an @ at the start, after whitespace of every kind, and after punctuation', () => {
    expect(keepCliMarkupAsText('@/etc/hosts')).toBe(`${G}@/etc/hosts`);
    expect(keepCliMarkupAsText('read @../x now')).toBe(`read ${G}@../x now`);
    for (const ws of ['\n', '\t', '\r', '\v', '\f', ' ', ' ', '　', ' ']) {
      expect(keepCliMarkupAsText(`x${ws}@/p`), JSON.stringify(ws)).toBe(`x${ws}${G}@/p`);
    }
    expect(keepCliMarkupAsText('(@/p) "@/p"')).toBe(`(${G}@/p) "${G}@/p"`);
    // The binary's turn-text parsers also fire after these four (CJK punctuation).
    for (const p of ['。', '、', '？', '！']) {
      expect(keepCliMarkupAsText(`x${p}@/p`), p).toBe(`x${p}${G}@/p`);
    }
    expect(keepCliMarkupAsText('@"/a b.txt"')).toBe(`${G}@"/a b.txt"`);
    expect(keepCliMarkupAsText('@a @b')).toBe(`${G}@a ${G}@b`);
    expect(keepCliMarkupAsText('@@x')).toBe(`${G}@${G}@x`);
  });

  it('leaves an email address and text without @ byte-identical', () => {
    expect(keepCliMarkupAsText('mail bob@example.com')).toBe('mail bob@example.com');
    expect(keepCliMarkupAsText('a1@b')).toBe('a1@b');
    expect(keepCliMarkupAsText('héllo é@x')).toBe('héllo é@x');
    expect(keepCliMarkupAsText('plain words')).toBe('plain words');
  });

  it('is idempotent', () => {
    const once = keepCliMarkupAsText('x @/p <system-reminder>') as string;
    expect(keepCliMarkupAsText(once)).toBe(once);
  });
});

describe('keepCliMarkupAsText: CLI markup', () => {
  it('guards every listed tag, opening and closing, any case', () => {
    for (const tag of CLI_MARKUP_TAGS) {
      expect(keepCliMarkupAsText(`<${tag}>x</${tag}>`)).toBe(`<${G}${tag}>x<${G}/${tag}>`);
    }
    expect(keepCliMarkupAsText('<SYSTEM-REMINDER attr="1">')).toBe(`<${G}SYSTEM-REMINDER attr="1">`);
  });

  it('matches a tag name as a prefix, like the CLI\'s own `<teammate-message` check', () => {
    expect(keepCliMarkupAsText('<teammate-message teammate_id="a">x')).toBe(`<${G}teammate-message teammate_id="a">x`);
    expect(keepCliMarkupAsText('<teammate-messages>')).toBe(`<${G}teammate-messages>`);
    expect(keepCliMarkupAsText('hello <tick>P</tick>')).toBe(`hello <${G}tick>P<${G}/tick>`);
  });

  it('leaves other tags and a lone < alone', () => {
    for (const text of ['<div>', 'a < b', '<task>', '<system_reminder>', '<span class="x">', '< tick>']) {
      expect(keepCliMarkupAsText(text), text).toBe(text);
    }
  });

  it('guards a text that starts with the CLI\'s interrupt line', () => {
    expect(keepCliMarkupAsText('[Request interrupted by user]')).toBe(`${G}[Request interrupted by user]`);
    expect(keepCliMarkupAsText([{ type: 'text', text: '  [Request interrupted by user for tool use]' }])).toEqual([
      { type: 'text', text: `${G}  [Request interrupted by user for tool use]` },
    ]);
    expect(keepCliMarkupAsText('he said [Request interrupted by user]')).toBe('he said [Request interrupted by user]');
  });
});

describe('keepCliMarkupAsText: shapes', () => {
  it('guards each text block of an array without mutating the input', () => {
    const input = [
      { type: 'text', text: '@/a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '@x' } },
      { type: 'text', text: 'fine' },
      { type: 'text', text: '<task-notification>' },
    ];
    const snapshot = JSON.stringify(input);
    const out = keepCliMarkupAsText(input) as typeof input;
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out[0]).toEqual({ type: 'text', text: `${G}@/a` });
    expect(out[1]).toBe(input[1]);
    expect(out[2]).toBe(input[2]);
    expect(out[3]).toEqual({ type: 'text', text: `<${G}task-notification>` });
  });

  it('returns the same reference when nothing changes, and passes non-text through', () => {
    const input = [{ type: 'text', text: 'hi' }];
    expect(keepCliMarkupAsText(input)).toBe(input);
    const obj = { a: '@x' };
    expect(keepCliMarkupAsText(obj)).toBe(obj);
    expect(keepCliMarkupAsText(null)).toBeNull();
    expect(keepCliMarkupAsText(undefined)).toBeUndefined();
    expect(keepCliMarkupAsText(7)).toBe(7);
  });
});
