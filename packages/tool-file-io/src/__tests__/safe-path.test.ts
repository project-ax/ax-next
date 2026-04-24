import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { safePath } from '../safe-path.js';
import { PluginError } from '@ax/core';

async function mkRoot() {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-safepath-')));
}

describe('safePath', () => {
  it('accepts a relative path inside root', async () => {
    const root = await mkRoot();
    expect(await safePath(root, 'a/b.txt')).toBe(path.join(root, 'a', 'b.txt'));
  });

  it('accepts the root itself via "."', async () => {
    const root = await mkRoot();
    expect(await safePath(root, '.')).toBe(root);
  });

  it('rejects a segment equal to ".."', async () => {
    const root = await mkRoot();
    await expect(safePath(root, '../etc/passwd')).rejects.toBeInstanceOf(PluginError);
  });

  it('I3: ACCEPTS "..foo.txt" (not a traversal)', async () => {
    const root = await mkRoot();
    expect(await safePath(root, '..foo.txt')).toBe(path.join(root, '..foo.txt'));
  });

  it('I3: ACCEPTS ".hidden"', async () => {
    const root = await mkRoot();
    expect(await safePath(root, '.hidden')).toBe(path.join(root, '.hidden'));
  });

  it('rejects an absolute path', async () => {
    const root = await mkRoot();
    await expect(safePath(root, '/etc/passwd')).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects a null byte in the path', async () => {
    const root = await mkRoot();
    await expect(safePath(root, 'a\0b')).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects backslash in the path', async () => {
    const root = await mkRoot();
    await expect(safePath(root, 'a\\b')).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects a symlink inside root that points outside root', async () => {
    const root = await mkRoot();
    const outside = await mkRoot();
    await fs.symlink(outside, path.join(root, 'link'));
    await expect(safePath(root, 'link/evil.txt')).rejects.toBeInstanceOf(PluginError);
  });

  it('accepts a non-existent leaf inside root (for write_file)', async () => {
    const root = await mkRoot();
    expect(await safePath(root, 'new/dir/file.txt')).toBe(path.join(root, 'new', 'dir', 'file.txt'));
  });

  it('rejects empty string', async () => {
    const root = await mkRoot();
    await expect(safePath(root, '')).rejects.toBeInstanceOf(PluginError);
  });
});
