import { describe, expect, it } from 'vitest';
import type { FileChange } from '@ax/core';
import { filterToPolicy } from '../filter.js';

describe('filterToPolicy', () => {
  it('keeps .ax/ paths and drops non-policy paths', () => {
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
    const filtered = filterToPolicy(all);
    expect(filtered.map((c) => c.path)).toEqual([
      '.ax/CLAUDE.md',
      '.ax/skills/foo/SKILL.md',
    ]);
  });

  it('keeps .claude/ paths (Phase 0: SDK setting-source roots are policy-visible)', () => {
    const all: FileChange[] = [
      { path: '.claude/settings.json', kind: 'put', content: new Uint8Array() },
      { path: '.claude/agents/foo.md', kind: 'put', content: new Uint8Array() },
      {
        path: '.claude/skills/my-skill/SKILL.md',
        kind: 'put',
        content: new Uint8Array(),
      },
      { path: 'src/main.ts', kind: 'put', content: new Uint8Array() },
    ];
    const filtered = filterToPolicy(all);
    expect(filtered.map((c) => c.path)).toEqual([
      '.claude/settings.json',
      '.claude/agents/foo.md',
      '.claude/skills/my-skill/SKILL.md',
    ]);
  });

  it('passes through both .ax/ and .claude/ in a mixed change set', () => {
    const all: FileChange[] = [
      { path: '.ax/skills/a/SKILL.md', kind: 'put', content: new Uint8Array() },
      {
        path: '.claude/settings.json',
        kind: 'put',
        content: new Uint8Array(),
      },
      { path: 'src/main.ts', kind: 'put', content: new Uint8Array() },
    ];
    const filtered = filterToPolicy(all);
    expect(filtered.map((c) => c.path).sort()).toEqual([
      '.ax/skills/a/SKILL.md',
      '.claude/settings.json',
    ]);
  });

  // SDK root memory files: the Claude Agent SDK reads CLAUDE.md /
  // CLAUDE.local.md at the project root with `settingSources: ['project']`.
  // Those root-level paths have no `.ax/` or `.claude/` prefix, so the
  // prefix list alone would drop them before the validator's veto could
  // fire. The filter MUST forward them.
  it('passes through root-level CLAUDE.md to policy', () => {
    const filtered = filterToPolicy([
      { path: 'CLAUDE.md', kind: 'put', content: new Uint8Array() },
    ]);
    expect(filtered.map((c) => c.path)).toEqual(['CLAUDE.md']);
  });

  it('passes through root-level CLAUDE.local.md to policy', () => {
    const filtered = filterToPolicy([
      { path: 'CLAUDE.local.md', kind: 'put', content: new Uint8Array() },
    ]);
    expect(filtered.map((c) => c.path)).toEqual(['CLAUDE.local.md']);
  });

  it('passes through deletes of root-level CLAUDE.md / CLAUDE.local.md', () => {
    const filtered = filterToPolicy([
      { path: 'CLAUDE.md', kind: 'delete' },
      { path: 'CLAUDE.local.md', kind: 'delete' },
    ]);
    expect(filtered.map((c) => c.path).sort()).toEqual([
      'CLAUDE.local.md',
      'CLAUDE.md',
    ]);
  });

  it('does NOT pass through root-level non-SDK files (regression guard)', () => {
    // CLAUDE.md is policy-visible; src/main.ts and README.md are not.
    // Make sure the exact-path opt-in doesn't accidentally widen to
    // "any root-level file."
    const filtered = filterToPolicy([
      { path: 'src/main.ts', kind: 'put', content: new Uint8Array() },
      { path: 'README.md', kind: 'put', content: new Uint8Array() },
      { path: 'package.json', kind: 'put', content: new Uint8Array() },
      // Lookalikes that are NOT in the exact set:
      { path: 'CLAUDE', kind: 'put', content: new Uint8Array() },
      { path: 'CLAUDE.md.bak', kind: 'put', content: new Uint8Array() },
      { path: 'claude.md', kind: 'put', content: new Uint8Array() }, // case-sensitive
    ]);
    expect(filtered).toEqual([]);
  });

  it('returns an empty array when no policy paths are present', () => {
    expect(
      filterToPolicy([
        { path: 'a.txt', kind: 'put', content: new Uint8Array() },
        { path: 'b.txt', kind: 'delete' },
      ]),
    ).toEqual([]);
  });

  it('returns an empty array on an empty input', () => {
    expect(filterToPolicy([])).toEqual([]);
  });

  it('treats deletes the same as puts (path is the only criterion)', () => {
    const r = filterToPolicy([
      { path: '.ax/old.md', kind: 'delete' },
      { path: '.ax/CLAUDE.md', kind: 'put', content: new Uint8Array() },
      { path: '.claude/settings.json', kind: 'delete' },
    ]);
    expect(r).toHaveLength(3);
  });

  it('does NOT match paths that merely contain ".ax/" or ".claude/" — must be a prefix', () => {
    // A path like "src/.ax/foo" lives under src/, not under .ax/. The
    // policy is rooted at the workspace root.
    expect(
      filterToPolicy([
        { path: 'src/.ax/foo', kind: 'put', content: new Uint8Array() },
        { path: 'foo.ax/bar', kind: 'put', content: new Uint8Array() },
        { path: '.ax-backup/x', kind: 'put', content: new Uint8Array() },
        { path: 'src/.claude/settings.json', kind: 'put', content: new Uint8Array() },
        { path: '.claude-plugin/x', kind: 'put', content: new Uint8Array() },
      ]),
    ).toEqual([]);
  });

  it('keeps .ax/ at the exact root', () => {
    // The literal `.ax/` (a slash with nothing after) is degenerate but
    // legal — the input slice doesn't include the workspace root, so a
    // change at `.ax/` would be a directory operation we don't see in
    // FileChange anyway. Checking it just to pin the prefix semantic.
    expect(
      filterToPolicy([{ path: '.ax/', kind: 'delete' }]),
    ).toEqual([{ path: '.ax/', kind: 'delete' }]);
  });
});
