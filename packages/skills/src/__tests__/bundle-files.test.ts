import { describe, it, expect } from 'vitest';
import { validateBundleFiles } from '../bundle-files.js';

describe('validateBundleFiles', () => {
  it('accepts well-formed extra files', () => {
    expect(() =>
      validateBundleFiles([
        { path: 'scripts/run.py', contents: 'print(1)' },
        { path: 'data/x.json', contents: '{}' },
      ]),
    ).not.toThrow();
  });

  it('accepts an empty file set', () => {
    expect(() => validateBundleFiles([])).not.toThrow();
  });

  it.each([
    ['SKILL.md'], // reconstructed from columns — never an extra file
    ['.mcp.json'], // generated from mcpServers
    ['.claude/settings.json'], // SDK auto-config
    ['.git/config'], // git internals
    ['../escape.txt'], // parent traversal
    ['/abs.txt'], // absolute
    ['UP.txt'], // uppercase not allowed by charset
    ['a\\b.txt'], // backslash not allowed
    ['has space.txt'], // space not allowed
    ['', undefined], // empty path
  ])('rejects %s', (path) => {
    expect(() => validateBundleFiles([{ path: path as string, contents: 'x' }])).toThrow();
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      validateBundleFiles([
        { path: 'a.txt', contents: '1' },
        { path: 'a.txt', contents: '2' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('enforces caps', () => {
    const tooMany = Array.from({ length: 17 }, (_, i) => ({ path: `f${i}.txt`, contents: 'x' }));
    expect(() => validateBundleFiles(tooMany)).toThrow(/at most 16/);
    expect(() =>
      validateBundleFiles([{ path: 'big.txt', contents: 'x'.repeat(256 * 1024 + 1) }]),
    ).toThrow(/256 KiB/);
  });

  it('enforces the total-bytes cap across files', () => {
    // 3 files at 200 KiB each = 600 KiB > 512 KiB total, each under the 256 KiB per-file cap.
    const big = 'x'.repeat(200 * 1024);
    expect(() =>
      validateBundleFiles([
        { path: 'a.txt', contents: big },
        { path: 'b.txt', contents: big },
        { path: 'c.txt', contents: big },
      ]),
    ).toThrow(/512 KiB total/);
  });

  it('rejects a path over 256 chars', () => {
    const longPath = 'a'.repeat(257);
    expect(() => validateBundleFiles([{ path: longPath, contents: 'x' }])).toThrow(/invalid bundle file path/i);
  });
});
