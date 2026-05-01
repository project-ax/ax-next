import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { repoPathFor } from '../repo-path.js';

describe('repoPathFor — happy path', () => {
  it('resolves a valid id under repoRoot', () => {
    const out = repoPathFor('/tmp/repos', 'abc');
    expect(out).toBe(`/tmp/repos${sep}abc.git`);
  });

  it('handles a relative repoRoot by resolving via path.resolve', () => {
    const out = repoPathFor('repos', 'abc');
    expect(out).toBe(resolve('repos', 'abc.git'));
  });

  it('handles a trailing-slash repoRoot identically', () => {
    const out = repoPathFor('/tmp/repos/', 'abc');
    expect(out).toBe(`/tmp/repos${sep}abc.git`);
  });
});

describe('repoPathFor — escape rejection', () => {
  it('rejects a traversal id even though prod validates upstream', () => {
    expect(() => repoPathFor('/tmp/repos', '../etc')).toThrow(
      /escapes repoRoot/,
    );
  });

  it('rejects nested traversal', () => {
    expect(() => repoPathFor('/tmp/repos', '../../etc/passwd')).toThrow(
      /escapes repoRoot/,
    );
  });

  it('rejects an id that resolves alongside repoRoot (no separator boundary)', () => {
    // candidate becomes `/tmp/repos-extra.git` — same prefix as `/tmp/repos`
    // but no separator after — the startsWith(rootResolved + sep) guard
    // exists for exactly this case.
    expect(() => repoPathFor('/tmp/repos', '../repos-extra')).toThrow(
      /escapes repoRoot/,
    );
  });
});
