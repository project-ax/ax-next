// TASK-690 -- `measureDirBytes` sums ALLOCATED bytes under a directory. These
// pin the walk on its own; the `workspace:usage` hook test lives next to it in
// usage-hook.test.ts.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { measureDirBytes } from '../disk-usage.js';

const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ax-disk-usage-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('measureDirBytes', () => {
  it('reports 0 for a directory that does not exist', async () => {
    expect(await measureDirBytes(join(tmp(), 'no-such-dir'))).toBe(0);
  });

  it('reports 0 for an empty directory', async () => {
    expect(await measureDirBytes(tmp())).toBe(0);
  });

  it('counts at least the logical size of a file', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.bin'), randomBytes(100_000));
    expect(await measureDirBytes(dir)).toBeGreaterThanOrEqual(100_000);
  });

  it('strictly grows when a second file is added', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.bin'), randomBytes(10_000));
    const one = await measureDirBytes(dir);
    writeFileSync(join(dir, 'b.bin'), randomBytes(10_000));
    const two = await measureDirBytes(dir);
    expect(two).toBeGreaterThan(one);
  });

  it('sums files in nested directories', async () => {
    const flat = tmp();
    writeFileSync(join(flat, 'a.bin'), randomBytes(20_000));
    writeFileSync(join(flat, 'b.bin'), randomBytes(20_000));

    const nested = tmp();
    mkdirSync(join(nested, 'x', 'y', 'z'), { recursive: true });
    writeFileSync(join(nested, 'x', 'a.bin'), randomBytes(20_000));
    writeFileSync(join(nested, 'x', 'y', 'z', 'b.bin'), randomBytes(20_000));

    // Two same-sized files count the same whether they sit at the top or three
    // levels down: only files are counted, not the directories around them.
    const nestedBytes = await measureDirBytes(nested);
    expect(nestedBytes).toBeGreaterThanOrEqual(40_000);
    expect(nestedBytes).toBe(await measureDirBytes(flat));
  });

  it('does not follow a symlink to a big file elsewhere', async () => {
    const outside = tmp();
    writeFileSync(join(outside, 'big.bin'), randomBytes(2_000_000));
    const dir = tmp();
    writeFileSync(join(dir, 'small.bin'), randomBytes(1_000));
    const before = await measureDirBytes(dir);
    symlinkSync(join(outside, 'big.bin'), join(dir, 'link-to-file'));
    const after = await measureDirBytes(dir);
    // The link itself is a directory entry (a few bytes at most); the 2 MB
    // target must not be counted.
    expect(after - before).toBeLessThan(100_000);
  });

  it('does not descend into a symlinked directory', async () => {
    const outside = tmp();
    writeFileSync(join(outside, 'big.bin'), randomBytes(2_000_000));
    const dir = tmp();
    writeFileSync(join(dir, 'small.bin'), randomBytes(1_000));
    const before = await measureDirBytes(dir);
    symlinkSync(outside, join(dir, 'link-to-dir'));
    const after = await measureDirBytes(dir);
    expect(after - before).toBeLessThan(100_000);
  });

  it('survives a symlink loop', async () => {
    const dir = tmp();
    symlinkSync(dir, join(dir, 'loop'));
    await expect(measureDirBytes(dir)).resolves.toBeGreaterThanOrEqual(0);
  });

  it('handles a directory with more entries than the concurrency pool', async () => {
    const dir = tmp();
    for (let i = 0; i < 100; i++) writeFileSync(join(dir, `f${i}`), 'x');
    // 100 files, each at least one byte on any filesystem.
    expect(await measureDirBytes(dir)).toBeGreaterThanOrEqual(100);
  });

  it('propagates an error that is not ENOENT', async () => {
    const dir = tmp();
    const file = join(dir, 'plain-file');
    writeFileSync(file, 'x');
    // A path whose parent is a regular file: ENOTDIR, not "absent".
    await expect(measureDirBytes(join(file, 'child'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});
