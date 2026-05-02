import { describe, expect, it } from 'vitest';
import type { FileChange } from '@ax/core';
import { filterToAx } from '../filter.js';

describe('filterToAx', () => {
  it('keeps .ax/ paths and drops everything else', () => {
    const all: FileChange[] = [
      { path: '.ax/CLAUDE.md', kind: 'put', content: new Uint8Array() },
      {
        path: '.ax/skills/foo/SKILL.md',
        kind: 'put',
        content: new TextEncoder().encode('---\nname: foo\n---\n'),
      },
      { path: 'src/main.ts', kind: 'put', content: new Uint8Array() },
      { path: '.gitignore', kind: 'delete' },
      { path: 'README.md', kind: 'delete' },
    ];
    const filtered = filterToAx(all);
    expect(filtered.map((c) => c.path)).toEqual([
      '.ax/CLAUDE.md',
      '.ax/skills/foo/SKILL.md',
    ]);
  });

  it('returns an empty array when no .ax paths are present', () => {
    expect(
      filterToAx([
        { path: 'a.txt', kind: 'put', content: new Uint8Array() },
        { path: 'b.txt', kind: 'delete' },
      ]),
    ).toEqual([]);
  });

  it('returns an empty array on an empty input', () => {
    expect(filterToAx([])).toEqual([]);
  });

  it('treats deletes the same as puts (path is the only criterion)', () => {
    const r = filterToAx([
      { path: '.ax/old.md', kind: 'delete' },
      { path: '.ax/CLAUDE.md', kind: 'put', content: new Uint8Array() },
    ]);
    expect(r).toHaveLength(2);
    expect(r.map((c) => c.kind).sort()).toEqual(['delete', 'put']);
  });

  it('does NOT match paths that merely contain ".ax/" — must be a prefix', () => {
    // A path like "src/.ax/foo" lives under src/, not under .ax/. The
    // policy is rooted at the workspace root.
    expect(
      filterToAx([
        { path: 'src/.ax/foo', kind: 'put', content: new Uint8Array() },
        { path: 'foo.ax/bar', kind: 'put', content: new Uint8Array() },
        { path: '.ax-backup/x', kind: 'put', content: new Uint8Array() },
      ]),
    ).toEqual([]);
  });

  it('keeps .ax/ at the exact root', () => {
    // The literal `.ax/` (a slash with nothing after) is degenerate but
    // legal — the input slice doesn't include the workspace root, so a
    // change at `.ax/` would be a directory operation we don't see in
    // FileChange anyway. Checking it just to pin the prefix semantic.
    expect(
      filterToAx([{ path: '.ax/', kind: 'delete' }]),
    ).toEqual([{ path: '.ax/', kind: 'delete' }]);
  });
});
