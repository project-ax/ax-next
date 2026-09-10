import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFINED_READ_LIMITS,
  confineByRealpath,
  readConfinedUserFiles,
  safeJoinUnderRoot,
} from '../confined-read.js';

// ---------------------------------------------------------------------------
// The confinement spec, at the library level.
//
// This file is the reason the package exists. The same properties are also
// asserted through @ax/sandbox-subprocess's resolver path (which proves the
// WIRING) and by the k8s reader pod's shell script; here they are asserted
// against the reader itself, with no bus and no mount resolver in the way, so a
// regression points at the line that broke rather than at a provider.
//
// Every SECURITY case below is a real thing an untrusted agent can do inside
// its own subtree, which it writes freely.
// ---------------------------------------------------------------------------

let tmp: string;
/** The agent's own subtree — the root a request is entitled to read. */
let root: string;

beforeEach(async () => {
  // realpath the tmp dir: macOS hands out /var/... which is a symlink to
  // /private/var, and a confinement test that compares unresolved paths would
  // pass or fail for reasons that have nothing to do with the code.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-ufr-')));
  root = path.join(tmp, 'agent-a');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'hello.txt'), 'hi');
  await fs.writeFile(path.join(root, 'docs', 'note.md'), '# note');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('safeJoinUnderRoot', () => {
  it('resolves an empty / undefined / dot relPath to the root itself', () => {
    expect(safeJoinUnderRoot(root, undefined)).toBe(root);
    expect(safeJoinUnderRoot(root, '')).toBe(root);
    expect(safeJoinUnderRoot(root, '.')).toBe(root);
  });

  it('joins a nested relative path', () => {
    expect(safeJoinUnderRoot(root, 'docs/note.md')).toBe(
      path.join(root, 'docs', 'note.md'),
    );
  });

  it('SECURITY: throws on a `..` segment', () => {
    expect(() => safeJoinUnderRoot(root, '../agent-b/secret')).toThrow(/\.\./);
    expect(() => safeJoinUnderRoot(root, 'docs/../../agent-b')).toThrow(/\.\./);
  });

  it('SECURITY: throws on an absolute path', () => {
    expect(() => safeJoinUnderRoot(root, '/etc/passwd')).toThrow(/relative/);
  });
});

describe('confineByRealpath', () => {
  it('returns the realpath of a target inside the root', async () => {
    const got = await confineByRealpath(root, path.join(root, 'hello.txt'));
    expect(got).toBe(path.join(root, 'hello.txt'));
  });

  it('returns undefined for a target outside the root', async () => {
    await fs.writeFile(path.join(tmp, 'outside.txt'), 'nope');
    expect(await confineByRealpath(root, path.join(tmp, 'outside.txt'))).toBeUndefined();
  });

  it('returns undefined for a missing target', async () => {
    expect(await confineByRealpath(root, path.join(root, 'nope'))).toBeUndefined();
  });

  it('SECURITY: does not confuse a sibling whose name PREFIXES the root', async () => {
    // `<tmp>/agent-a-evil` starts with `<tmp>/agent-a` as a STRING but is a
    // different directory. A `startsWith(root)` check without the separator
    // would let it through.
    const sibling = path.join(tmp, 'agent-a-evil');
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'secret'), 'SECRET');
    expect(await confineByRealpath(root, path.join(sibling, 'secret'))).toBeUndefined();
  });
});

describe('readConfinedUserFiles', () => {
  it('lists the root directory', async () => {
    const out = await readConfinedUserFiles(root, undefined);
    expect(out.kind).toBe('dir');
    if (out.kind !== 'dir') throw new Error('expected dir');
    const byName = new Map(out.entries.map((e) => [e.name, e.kind]));
    expect(byName.get('hello.txt')).toBe('file');
    expect(byName.get('docs')).toBe('dir');
  });

  it('reads a nested file, exact bytes', async () => {
    const out = await readConfinedUserFiles(root, 'docs/note.md');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('# note');
  });

  it('reads a binary file byte-for-byte (no text round-trip)', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x80]);
    await fs.writeFile(path.join(root, 'blob.bin'), bytes);
    const out = await readConfinedUserFiles(root, 'blob.bin');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).equals(bytes)).toBe(true);
  });

  it('reads an empty file as zero bytes, not as absent', async () => {
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    const out = await readConfinedUserFiles(root, 'empty.txt');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(0);
  });

  it('a missing path is absent', async () => {
    expect(await readConfinedUserFiles(root, 'nope/missing.txt')).toEqual({
      kind: 'absent',
    });
  });

  it('a root that does not exist at all is absent, not a throw', async () => {
    expect(
      await readConfinedUserFiles(path.join(tmp, 'never-written'), undefined),
    ).toEqual({ kind: 'absent' });
  });

  it('a fifo (not a file or dir) is absent', async () => {
    // A device/socket/fifo is nothing a file browser should serve. Skipped
    // where mkfifo is unavailable rather than asserted differently per-OS.
    const fifo = path.join(root, 'pipe');
    const { spawnSync } = await import('node:child_process');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) return;
    expect(await readConfinedUserFiles(root, 'pipe')).toEqual({ kind: 'absent' });
    const list = await readConfinedUserFiles(root, undefined);
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).not.toContain('pipe');
  });

  // --- the caps ---------------------------------------------------------

  it('caps a file read at maxFileBytes and returns the PREFIX (not absent)', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(50));
    const out = await readConfinedUserFiles(root, 'big.txt', {
      maxFileBytes: 10,
      maxDirEntries: 100,
    });
    if (out.kind !== 'file') throw new Error('expected file');
    // A prefix, not an error and not an `absent`: "no such file" over a file
    // the agent definitely wrote is the lie this surface exists to avoid.
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('xxxxxxxxxx');
  });

  it('caps a directory listing at maxDirEntries', async () => {
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(path.join(root, `f${String(i)}.txt`), '.');
    }
    const out = await readConfinedUserFiles(root, undefined, {
      maxFileBytes: 1024,
      maxDirEntries: 5,
    });
    if (out.kind !== 'dir') throw new Error('expected dir');
    expect(out.entries).toHaveLength(5);
  });

  it('the default byte cap matches the k8s reader pod (1 MiB)', () => {
    // Both realizations of `sandbox:read-user-files` must return the same
    // bytes for the same file — a browser that shows a different amount of a
    // file depending on which sandbox provider is loaded is unreasonable-about.
    expect(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes).toBe(1024 * 1024);
  });

  // --- confinement ------------------------------------------------------

  it('SECURITY: a `..` relPath throws (our own caller is malformed)', async () => {
    await fs.writeFile(path.join(tmp, 'secret'), 'TOPSECRET');
    await expect(readConfinedUserFiles(root, '../secret')).rejects.toThrow(/\.\./);
  });

  it('SECURITY: an absolute relPath throws', async () => {
    await expect(readConfinedUserFiles(root, '/etc/passwd')).rejects.toThrow(
      /relative/,
    );
  });

  it('SECURITY: a FINAL-component symlink out of the root is absent and unlisted', async () => {
    await fs.writeFile(path.join(tmp, 'outside.txt'), 'OUTSIDE');
    await fs.symlink(path.join(tmp, 'outside.txt'), path.join(root, 'link.txt'));
    expect(await readConfinedUserFiles(root, 'link.txt')).toEqual({ kind: 'absent' });
    const list = await readConfinedUserFiles(root, undefined);
    if (list.kind !== 'dir') throw new Error('expected dir');
    // Never even NAMED: a name we hand back is a name the client will ask us
    // to open, and offering one we would refuse invites probing.
    expect(list.entries.map((e) => e.name)).not.toContain('link.txt');
  });

  it('SECURITY: an INTERMEDIATE symlink to a sibling subtree discloses nothing', async () => {
    // The disclosure a lexical `..` guard does NOT catch: the agent plants a
    // dir symlink inside its OWN subtree pointing at a sibling's, then reads
    // through it. Only realpath confinement stops this.
    const other = path.join(tmp, 'agent-b');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'secret.txt'), 'AGENT-B-SECRET');
    await fs.symlink(other, path.join(root, 'escape'));

    expect(await readConfinedUserFiles(root, 'escape/secret.txt')).toEqual({
      kind: 'absent',
    });
    expect(await readConfinedUserFiles(root, 'escape')).toEqual({ kind: 'absent' });
    const list = await readConfinedUserFiles(root, undefined);
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).not.toContain('escape');
    // And the sibling's bytes are untouched.
    expect(
      (await fs.readFile(path.join(other, 'secret.txt'))).toString('utf-8'),
    ).toBe('AGENT-B-SECRET');
  });

  it('SECURITY: an INTERMEDIATE symlink to the host filesystem root discloses nothing', async () => {
    await fs.symlink('/', path.join(root, 'rootlink'));
    expect(await readConfinedUserFiles(root, 'rootlink/etc/hostname')).toEqual({
      kind: 'absent',
    });
  });

  it('SECURITY: a symlink to the root ITSELF is still not served', async () => {
    // Escaping is not the only thing a link can do; a self-referential link is
    // still a link, and this surface serves files and dirs only.
    await fs.symlink(root, path.join(root, 'self'));
    const list = await readConfinedUserFiles(root, undefined);
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).not.toContain('self');
  });

  it('SECURITY: the read never opens a writable handle — mtime and size unchanged', async () => {
    const target = path.join(root, 'hello.txt');
    const before = await fs.stat(target);
    await readConfinedUserFiles(root, 'hello.txt');
    const after = await fs.stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it('SECURITY: a read-only root is enough — no write is attempted', async () => {
    // The host mount is `readOnly: true`, so a reader that tried to open for
    // write would fail in production and pass in a test with a writable temp
    // dir. Drop write permission and assert the read still works.
    await fs.chmod(root, 0o555);
    try {
      const out = await readConfinedUserFiles(root, 'hello.txt');
      if (out.kind !== 'file') throw new Error('expected file');
      expect(Buffer.from(out.contents).toString('utf-8')).toBe('hi');
    } finally {
      await fs.chmod(root, 0o755);
    }
  });
});
