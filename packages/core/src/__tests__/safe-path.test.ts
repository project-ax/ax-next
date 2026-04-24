import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { safePath, assertWithinBase } from '../util/safe-path.js';

describe('safePath', () => {
  const base = '/tmp/ax-safe-path-base';

  it('accepts a normal relative segment', () => {
    expect(safePath(base, 'hello.txt')).toBe(resolve(base, 'hello.txt'));
  });

  it('accepts nested relative segments', () => {
    expect(safePath(base, 'src', 'a.ts')).toBe(resolve(base, 'src', 'a.ts'));
  });

  it('rejects ".." traversal by sanitizing rather than escaping the base', () => {
    // ".." sequences become underscores, so the result stays inside base.
    const out = safePath(base, '..', 'etc', 'passwd');
    expect(out.startsWith(resolve(base) + '/')).toBe(true);
    expect(out).not.toContain('..');
  });

  it('rejects absolute-path-like segments by sanitizing leading slashes', () => {
    const out = safePath(base, '/etc/passwd');
    expect(out.startsWith(resolve(base) + '/')).toBe(true);
  });

  it('strips NUL bytes from segments', () => {
    const out = safePath(base, 'no\0nul.txt');
    expect(out.includes('\0')).toBe(false);
  });

  it('still produces a path under base for ordinary segments (containment check passes)', () => {
    const out = safePath(base, 'a', 'b', 'c.txt');
    expect(out.startsWith(resolve(base) + '/')).toBe(true);
  });
});

describe('assertWithinBase', () => {
  const base = '/tmp/ax-safe-path-base';

  it('accepts a path inside base', () => {
    expect(assertWithinBase(base, resolve(base, 'a/b'))).toBe(resolve(base, 'a/b'));
  });

  it('rejects a path outside base', () => {
    expect(() => assertWithinBase(base, '/etc/passwd')).toThrow(/outside base/);
  });

  it('accepts the base itself', () => {
    expect(assertWithinBase(base, base)).toBe(resolve(base));
  });
});
