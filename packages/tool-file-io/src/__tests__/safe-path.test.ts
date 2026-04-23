import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginError } from '@ax/core';
import { safePath } from '../safe-path.js';

describe('safePath', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-file-io-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a relative path inside root', async () => {
    writeFileSync(join(root, 'a.txt'), 'hi');
    const out = await safePath(root, 'a.txt');
    expect(out).toBe(join(root, 'a.txt'));
  });

  it('rejects ../../etc/passwd traversal', async () => {
    await expect(safePath(root, '../../etc/passwd')).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects absolute paths', async () => {
    await expect(safePath(root, '/etc/passwd')).rejects.toMatchObject({
      code: 'invalid-payload',
    });
  });

  it('rejects a symlink inside root that points outside root', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ax-file-io-outside-')));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'pwned');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      await expect(safePath(root, 'link.txt')).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts the root itself (candidate ".")', async () => {
    const out = await safePath(root, '.');
    expect(out).toBe(root);
  });

  it('accepts a not-yet-existing file (realpath on parent)', async () => {
    const out = await safePath(root, 'newfile.txt');
    expect(out).toBe(join(root, 'newfile.txt'));
  });

  it('accepts a not-yet-existing file in a nested existing dir', async () => {
    mkdirSync(join(root, 'sub'));
    const out = await safePath(root, 'sub/new.txt');
    expect(out).toBe(join(root, 'sub', 'new.txt'));
  });
});
