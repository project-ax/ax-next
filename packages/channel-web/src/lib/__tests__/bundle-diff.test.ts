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
});
