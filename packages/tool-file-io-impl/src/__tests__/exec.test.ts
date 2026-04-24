import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readFile, writeFile, MAX_FILE_BYTES } from '../exec.js';

async function mkRoot() {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-file-io-impl-')));
}

describe('readFile / writeFile', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkRoot();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('writeFile then readFile round-trips content + bytes', async () => {
    await writeFile({ path: 'a.txt', content: 'hello' }, { workspaceRoot });
    const result = await readFile({ path: 'a.txt' }, { workspaceRoot });
    expect(result).toEqual({ path: 'a.txt', content: 'hello', bytes: 5 });
  });

  it('readFile on a missing file rejects with ENOENT-shaped error', async () => {
    await expect(
      readFile({ path: 'does-not-exist.txt' }, { workspaceRoot }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('readFile on a file exceeding MAX_FILE_BYTES rejects before reading', async () => {
    // Write a file just over the cap by bypassing our own writeFile cap
    // check — we want to exercise the read-side cap specifically.
    const target = path.join(workspaceRoot, 'big.bin');
    // Using fs.truncate creates a sparse file on most filesystems, so we
    // don't actually allocate a megabyte of disk for this test.
    const fh = await fs.open(target, 'w');
    try {
      await fh.truncate(MAX_FILE_BYTES + 1);
    } finally {
      await fh.close();
    }
    await expect(
      readFile({ path: 'big.bin' }, { workspaceRoot }),
    ).rejects.toThrow(/exceeds/);
  });

  it('writeFile rejects emoji-heavy content over UTF-8 cap even if UTF-16 length would fit', async () => {
    // '😀' is 2 UTF-16 code units but 4 UTF-8 bytes. 300_000 repeats =
    // 600_000 UTF-16 units (under a hypothetical 1_048_576 char cap) but
    // 1_200_000 UTF-8 bytes — definitively over 1 MiB.
    const content = '😀'.repeat(300_000);
    expect(content.length).toBe(600_000);
    expect(Buffer.byteLength(content, 'utf8')).toBe(1_200_000);
    await expect(
      writeFile({ path: 'e.txt', content }, { workspaceRoot }),
    ).rejects.toThrow(/exceeds/);
  });

  it("writeFile with a '..'-escaping path rejects via safePath", async () => {
    await expect(
      writeFile({ path: '../escaped.txt', content: 'x' }, { workspaceRoot }),
    ).rejects.toThrow(/\.\./);
  });

  it('writeFile creates parent directories recursively', async () => {
    await writeFile(
      { path: 'deeply/nested/dir/file.txt', content: 'ok' },
      { workspaceRoot },
    );
    const onDisk = await fs.readFile(
      path.join(workspaceRoot, 'deeply', 'nested', 'dir', 'file.txt'),
      'utf8',
    );
    expect(onDisk).toBe('ok');
  });

  it('readFile rejects an oversized path string (>4096 chars)', async () => {
    const longPath = 'a'.repeat(4097);
    await expect(readFile({ path: longPath }, { workspaceRoot })).rejects.toThrow(
      /path must be a string/,
    );
  });

  it('writeFile rejects an oversized path string (>4096 chars)', async () => {
    const longPath = 'a'.repeat(4097);
    await expect(
      writeFile({ path: longPath, content: 'x' }, { workspaceRoot }),
    ).rejects.toThrow(/path must be a string/);
  });
});
