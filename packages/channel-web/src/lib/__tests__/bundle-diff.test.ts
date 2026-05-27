import { describe, it, expect } from 'vitest';
import { reconstructSkillMd, diffLines, compareBundles } from '../bundle-diff';

describe('reconstructSkillMd', () => {
  it('fences the manifest and appends the body', () => {
    expect(reconstructSkillMd('name: x\n', '# Body\n')).toBe('---\nname: x\n---\n# Body\n');
  });
  it('adds a missing trailing newline to the manifest', () => {
    expect(reconstructSkillMd('name: x', '# B')).toBe('---\nname: x\n---\n# B');
  });
});

describe('diffLines', () => {
  it('marks added, removed, and context lines', () => {
    const out = diffLines('a\nb\nc', 'a\nB\nc');
    expect(out).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ]);
  });
  it('handles empty before (all adds)', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('falls back to a whole-file replace above the line cap (no quadratic blowup)', () => {
    // Untrusted bundle files can be hundreds of KiB; an LCS dp table of
    // (m+1)*(n+1) cells would OOM/hang. Above the cap we degrade to a
    // remove-all-then-add-all diff — still shows every byte, bounded work.
    const before = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const start = Date.now();
    const out = diffLines(before, after);
    expect(Date.now() - start).toBeLessThan(2000); // would be many seconds with full LCS
    // Every original line removed, every new line added; nothing dropped.
    expect(out.filter((l) => l.type === 'remove')).toHaveLength(3000);
    expect(out.filter((l) => l.type === 'add')).toHaveLength(3000);
    expect(out.filter((l) => l.type === 'context')).toHaveLength(0);
    expect(out[0]).toEqual({ type: 'remove', text: 'b0' });
    expect(out[out.length - 1]).toEqual({ type: 'add', text: 'a2999' });
  });

  it('still does a real line-level diff below the cap', () => {
    // Identical-but-for-one-line files under the cap keep the LCS context.
    const out = diffLines('a\nb\nc\nd', 'a\nb\nX\nd');
    expect(out.filter((l) => l.type === 'context').map((l) => l.text)).toEqual(['a', 'b', 'd']);
  });
});

describe('compareBundles', () => {
  it('classifies added / removed / modified / unchanged per path', () => {
    const before = { 'SKILL.md': '# v1', 'scripts/a.py': 'print(1)', 'gone.txt': 'x' };
    const after = { 'SKILL.md': '# v2', 'scripts/a.py': 'print(1)', 'new.txt': 'y' };
    const entries = compareBundles(before, after);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.status]));
    expect(byPath).toEqual({
      'SKILL.md': 'modified',
      'gone.txt': 'removed',
      'new.txt': 'added',
      'scripts/a.py': 'unchanged',
    });
    // sorted by path
    expect(entries.map((e) => e.path)).toEqual(['SKILL.md', 'gone.txt', 'new.txt', 'scripts/a.py']);
  });

  it('does NOT drop a file whose path is a magic key like __proto__', () => {
    // `__proto__` is a VALID bundle path (lowercase + underscores pass the
    // server PATH_RE and it is not reserved), and catalog:admit promotes it
    // verbatim. A plain {} map would treat map['__proto__'] = ... as the
    // prototype setter, so Object.keys would omit it from the review diff —
    // a file admitted but never shown. Null-prototype maps keep it visible.
    const before = Object.create(null) as Record<string, string>;
    const after = Object.create(null) as Record<string, string>;
    after['__proto__'] = 'evil contents';
    after['constructor'] = 'also tricky';
    const entries = compareBundles(before, after);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('__proto__');
    expect(paths).toContain('constructor');
    const proto = entries.find((e) => e.path === '__proto__')!;
    expect(proto.status).toBe('added');
    expect(proto.after).toBe('evil contents');
  });
});
