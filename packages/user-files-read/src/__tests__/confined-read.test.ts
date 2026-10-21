import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadUserFilesOutput } from '@ax/sandbox-mount-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFINED_READ_LIMITS,
  UserFilesReadError,
  readConfinedUserFiles,
  safeJoinUnderRoot,
} from '../confined-read.js';
import { MAX_WALK_PARTS, WalkPathError } from '../walk-read.js';

// ---------------------------------------------------------------------------
// The confinement spec, at the library level.
//
// This file is the reason the package exists. The same properties are also
// asserted through @ax/sandbox-subprocess's resolver path (which proves the
// WIRING) and by the k8s reader pod's shell script; here they are asserted
// against the reader itself, with no bus and no mount resolver in the way, so a
// regression points at the line that broke rather than at a provider.
//
// `readConfinedUserFiles` is an adapter over the component walk in
// walk-read.ts (TASK-899), and the walk needs Linux /proc. So every test that
// reads real files is skipped where /proc is missing (a macOS laptop), and
// runs in CI, which is ubuntu-latest. A skip there is not a pass. What the
// adapter decides before it touches the disk (the lexical refusals, the depth
// rule, the off-Linux refusal) runs everywhere.
//
// Every SECURITY case below is a real thing an untrusted agent can do inside
// its own subtree, which it writes freely, up to and including swapping a
// directory for a symlink while we are mid-read.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const SKIP_REASON = 'needs Linux /proc/self/fd (runs in CI on ubuntu-latest)';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const SECRET = 'SECRET-do-not-return';

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the promise to reject');
}

/** Run `fn` with `process.platform` reading 'darwin'. */
async function asDarwin(fn: () => Promise<void>): Promise<void> {
  const d = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...d, value: 'darwin' });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', d);
  }
}

const text = (r: ReadUserFilesOutput): string =>
  r.kind === 'file' ? Buffer.from(r.contents).toString('utf8') : '';

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

describe('readConfinedUserFiles — answered before the disk (every platform)', () => {
  it('the default byte cap matches the k8s reader pod (1 MiB)', () => {
    // Both realizations of `sandbox:read-user-files` must return the same
    // bytes for the same file — a browser that shows a different amount of a
    // file depending on which sandbox provider is loaded is unreasonable-about.
    expect(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes).toBe(1024 * 1024);
  });

  it('SECURITY: a `..` relPath throws (our own caller is malformed)', async () => {
    await fs.writeFile(path.join(tmp, 'secret'), 'TOPSECRET');
    const err = await rejection(readConfinedUserFiles(root, '../secret'));
    expect(err.message).toMatch(/\.\./);
    // The walk's own path check refuses `..` too, with a message that also
    // matches. Only the lexical guard (adapter step 1) throws a plain Error.
    expect(err).not.toBeInstanceOf(WalkPathError);
  });

  it('SECURITY: an absolute relPath throws', async () => {
    const err = await rejection(readConfinedUserFiles(root, '/etc/passwd'));
    expect(err.message).toMatch(/relative/);
    expect(err).not.toBeInstanceOf(WalkPathError);
  });

  it.each([
    ['an empty segment', 'a//b'],
    ['a trailing slash', 'docs/'],
    ['a dot segment', 'x/./y'],
    ['a NUL byte', 'notes\u0000.md'],
  ])(
    'a malformed path (%s) throws WalkPathError, not an answer (accepted behavior change)',
    async (_name, rel) => {
      // The reader this replaced served `docs/`, `a//b` and `x/./y`, and
      // answered NUL as absent. channel-web's `workspaceFilePath` rejects all of
      // these before they get here, so no shipped route can reach this.
      const err = await rejection(readConfinedUserFiles(root, rel));
      expect(err).toBeInstanceOf(WalkPathError);
      expect(err).not.toBeInstanceOf(UserFilesReadError);
      expect(err).toMatchObject({ code: 'invalid-path' });
    },
  );

  it('a path deeper than MAX_WALK_PARTS is absent, not an error', async () => {
    // The answer depends only on the path's text, so it is no oracle. A 5xx
    // would invite a retry that can never succeed.
    const deep = Array.from({ length: MAX_WALK_PARTS + 1 }, () => 'd').join('/');
    expect(await readConfinedUserFiles(root, deep)).toEqual({ kind: 'absent' });
  });

  it('a path of exactly MAX_WALK_PARTS is not refused by the depth rule', async () => {
    // The boundary: 33 parts answers `absent` from the text alone (above), 32
    // goes on to the walk. Off Linux the walk is where the platform refusal
    // lives, so reaching it is observable everywhere: the platform is stubbed
    // so Linux CI runs this too, where a `>=` slip would answer `absent`.
    const exact = Array.from({ length: MAX_WALK_PARTS }, () => 'd').join('/');
    await asDarwin(async () => {
      await expect(readConfinedUserFiles(root, exact)).rejects.toMatchObject({
        code: 'unsupported-platform',
      });
    });
  });

  it('off Linux the reader refuses instead of answering', async () => {
    // Without /proc every component open is ENOENT, so a reader that ran
    // anyway would answer `absent` for everything: a Files tab that says the
    // agent wrote nothing. The platform is stubbed so this runs, and has
    // teeth, on Linux CI too, where hello.txt is there to be (wrongly) served.
    await asDarwin(async () => {
      const out = readConfinedUserFiles(root, 'hello.txt');
      await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
      await expect(out).rejects.toMatchObject({ code: 'unsupported-platform' });
    });
  });
});

describe.skipIf(!ON_LINUX)(`readConfinedUserFiles — on disk (${SKIP_REASON})`, () => {
  it('lists the root directory', async () => {
    const out = await readConfinedUserFiles(root, undefined);
    expect(out.kind).toBe('dir');
    if (out.kind !== 'dir') throw new Error('expected dir');
    const byName = new Map(out.entries.map((e) => [e.name, e.kind]));
    expect(byName.get('hello.txt')).toBe('file');
    expect(byName.get('docs')).toBe('dir');
  });

  it("'.' and '' both read the root", async () => {
    // The k8s provider sends '.' for the root. The walk's own splitter refuses
    // '.', so this is the adapter's job, and without it every root listing on
    // k8s would throw.
    for (const rel of ['.', '']) {
      const out = await readConfinedUserFiles(root, rel);
      if (out.kind !== 'dir') throw new Error(`expected dir for ${JSON.stringify(rel)}`);
      expect(out.entries.map((e) => e.name).sort()).toEqual(['docs', 'hello.txt']);
    }
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

  it("answers carry only the hook's fields", async () => {
    // The walk's answers carry more: a `reason` on an absence (for tests and
    // diagnostics, and telling a link from a missing file is exactly the
    // oracle this surface must not offer) and `truncated` on a listing, which
    // the hook's dir answer has no field for.
    const file = await readConfinedUserFiles(root, 'hello.txt');
    expect(Object.keys(file).sort()).toEqual(['contents', 'kind', 'truncated']);
    const dir = await readConfinedUserFiles(root, 'docs');
    expect(Object.keys(dir).sort()).toEqual(['entries', 'kind']);
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

  it('a root that is a regular file is absent (ENOTDIR at the root open)', async () => {
    // ENOTDIR is only reachable at the root open: below the root the walk
    // answers a non-directory component itself.
    const file = path.join(tmp, 'not-a-dir');
    await fs.writeFile(file, 'x');
    expect(await readConfinedUserFiles(file, undefined)).toEqual({ kind: 'absent' });
    expect(await readConfinedUserFiles(file, 'hello.txt')).toEqual({ kind: 'absent' });
  });

  it('a root that is a symlink loop is absent (ELOOP at the root open)', async () => {
    const loop = path.join(tmp, 'loop');
    await fs.symlink('loop', loop);
    expect(await readConfinedUserFiles(loop, undefined)).toEqual({ kind: 'absent' });
  });

  it('a path of exactly MAX_WALK_PARTS components that exists is read', async () => {
    // 31 directories and a file: the deepest path the depth rule lets through.
    const dirs = Array.from({ length: MAX_WALK_PARTS - 1 }, () => 'd');
    await fs.mkdir(path.join(root, ...dirs), { recursive: true });
    await fs.writeFile(path.join(root, ...dirs, 'leaf.txt'), 'deep');
    const out = await readConfinedUserFiles(root, [...dirs, 'leaf.txt'].join('/'));
    expect(out.kind).toBe('file');
    expect(text(out)).toBe('deep');
  });

  it('a path segment longer than a filename may be is absent, not an error', async () => {
    // 256 bytes is one past NAME_MAX on every filesystem this runs on, so the
    // open fails ENAMETOOLONG. Like the depth rule, the answer depends only on
    // the path's text: no oracle, and a 5xx would invite a retry that can
    // never succeed.
    const long = 'x'.repeat(256);
    expect(await readConfinedUserFiles(root, long)).toEqual({ kind: 'absent' });
    expect(await readConfinedUserFiles(root, `docs/${long}`)).toEqual({ kind: 'absent' });
    // The shape that gets past the route: channel-web's path check caps a
    // segment at 255 UTF-16 units, and these 128 are 256 bytes.
    expect(await readConfinedUserFiles(root, 'é'.repeat(128))).toEqual({ kind: 'absent' });
  });

  it('a fifo (not a file or dir) is absent', async () => {
    // A device/socket/fifo is nothing a file browser should serve. mkfifo is
    // coreutils, so on the Linux boxes this runs on a failure is a broken
    // fixture, not a reason to pass quietly.
    const fifo = path.join(root, 'pipe');
    expect(spawnSync('mkfifo', [fifo]).status, `mkfifo ${fifo}`).toBe(0);
    expect(await readConfinedUserFiles(root, 'pipe')).toEqual({ kind: 'absent' });
    const list = await readConfinedUserFiles(root, undefined);
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).not.toContain('pipe');
  });

  it('a Unix socket is absent', async () => {
    // open(2) refuses a socket outright (ENXIO), unlike a FIFO, which it
    // would block on. Either way it is nothing a file browser serves.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(root, 'sock'), resolve);
    });
    try {
      expect(await readConfinedUserFiles(root, 'sock')).toEqual({ kind: 'absent' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('KNOWN GAP: a name that is not valid UTF-8 is left out of a listing', async () => {
    // Node decodes the name with U+FFFD for the bad byte, so the walk's lstat
    // of the re-encoded name finds nothing and the entry is skipped. Pinned so
    // that changing it is a decision; see the header's KNOWN GAPS.
    const docs = path.join(root, 'docs');
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // "café.txt" in Latin-1
    await fs.writeFile(Buffer.concat([Buffer.from(`${docs}/`), latin1]), 'x');
    // The fixture really is on disk under those bytes.
    const raw = await fs.readdir(docs, { encoding: 'buffer' });
    expect(raw.some((n) => n.equals(latin1))).toBe(true);

    const list = await readConfinedUserFiles(root, 'docs');
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries).toEqual([{ name: 'note.md', kind: 'file' }]);
    expect(await readConfinedUserFiles(root, 'docs/caf�.txt')).toEqual({ kind: 'absent' });
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
    // …and it SAYS it is a prefix. A consumer handing these bytes to a person
    // as the file cannot work this out from the length: see the next test.
    expect(out.truncated).toBe(true);
  });

  it('a file of EXACTLY maxFileBytes is whole, not truncated', async () => {
    /*
      The case a length cannot answer. Ten bytes of a ten-byte cap and the
      first ten bytes of an eleven-byte file are the same `contents.length`, so
      a consumer comparing against the cap would call this one truncated and
      refuse to hand over a perfectly complete file. The reader asks for one
      byte more than the cap precisely so these two are distinguishable, and
      this test is the half that a naive `length >= cap` check fails.
    */
    await fs.writeFile(path.join(root, 'exact.txt'), 'x'.repeat(10));
    const out = await readConfinedUserFiles(root, 'exact.txt', {
      maxFileBytes: 10,
      maxDirEntries: 100,
    });
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(10);
    expect(out.truncated).toBe(false);
  });

  it('a file under the cap is whole, and says so', async () => {
    await fs.writeFile(path.join(root, 'small.txt'), 'hi');
    const out = await readConfinedUserFiles(root, 'small.txt', {
      maxFileBytes: 10,
      maxDirEntries: 100,
    });
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.truncated).toBe(false);
  });

  it('an empty file is whole, not truncated', async () => {
    await fs.writeFile(path.join(root, 'nothing.txt'), '');
    const out = await readConfinedUserFiles(root, 'nothing.txt');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.truncated).toBe(false);
  });

  it('never returns MORE than the cap, even though it reads one byte past it', async () => {
    // The probe byte is a measurement, not payload. If it ever leaked into
    // `contents`, every consumer's own bound would be off by one.
    await fs.writeFile(path.join(root, 'huge.txt'), 'y'.repeat(500));
    const out = await readConfinedUserFiles(root, 'huge.txt', {
      maxFileBytes: 32,
      maxDirEntries: 100,
    });
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(32);
    expect(out.truncated).toBe(true);
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

  // --- confinement ------------------------------------------------------

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
    // through it. Only a reader that refuses a link at every component stops
    // this.
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

  it('SECURITY: an in-root symlink is not followed either', async () => {
    // Where a link points is never looked at. A realpath reader serves all
    // three of these, because each one resolves to a path inside the root;
    // the walk refuses them all, because each one IS a link at the moment it
    // is opened. This is the deterministic proof that the reader is the walk.
    await fs.symlink('hello.txt', path.join(root, 'alias.md'));
    await fs.symlink('docs', path.join(root, 'alias'));
    expect(await readConfinedUserFiles(root, 'alias.md')).toEqual({ kind: 'absent' });
    expect(await readConfinedUserFiles(root, 'alias/note.md')).toEqual({ kind: 'absent' });
    expect(await readConfinedUserFiles(root, 'alias')).toEqual({ kind: 'absent' });
  });

  it('SECURITY: a symlink to the root ITSELF is still not served', async () => {
    // Escaping is not the only thing a link can do; a self-referential link is
    // still a link, and this surface serves files and dirs only.
    await fs.symlink(root, path.join(root, 'self'));
    const list = await readConfinedUserFiles(root, undefined);
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).not.toContain('self');
  });

  it.skipIf(IS_ROOT)(
    'SECURITY: an intermediate directory the host may not search is a broken read, not an absence',
    async () => {
      // The walk has already opened `docs` inside this subtree when the lookup
      // of `note.md` is refused, so saying "refused" rather than "absent"
      // tells a prober nothing about anyone else's files (TASK-403).
      await fs.chmod(path.join(root, 'docs'), 0o000);
      try {
        const out = readConfinedUserFiles(root, 'docs/note.md');
        await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
        await expect(out).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await fs.chmod(path.join(root, 'docs'), 0o755);
      }
    },
  );

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

  // -------------------------------------------------------------------------
  // THE RACE. A child process swaps `a` between a real directory and a symlink
  // to an outside directory with the same shape, as fast as it can, while this
  // process reads `a/b/file.txt`. A check-then-open reader loses this race; a
  // walk that pins each component's descriptor cannot, because a symlink at
  // `a` fails its O_NOFOLLOW open at the moment we look.
  // -------------------------------------------------------------------------
  it(
    'SECURITY: a directory swapped for a symlink mid-read never yields the secret',
    async () => {
      const outside = path.join(tmp, 'outside');
      await fs.mkdir(path.join(outside, 'b'), { recursive: true });
      await fs.writeFile(path.join(outside, 'b', 'file.txt'), SECRET);

      const a = path.join(root, 'a');
      const real = path.join(root, 'a.real');
      const link = path.join(root, 'a.link');
      await fs.mkdir(path.join(real, 'b'), { recursive: true });
      await fs.writeFile(path.join(real, 'b', 'file.txt'), 'inside');
      await fs.symlink(outside, link);

      // The swapper: each round puts the real dir at `a`, then the link at
      // `a`. rename(2) is atomic, so `a` is always one of {dir, link, absent}.
      const swapper = spawn(
        process.execPath,
        [
          '-e',
          `
          const fs = require('node:fs');
          const [a, real, link] = process.argv.slice(1);
          process.stdout.write('ready\\n');
          for (;;) {
            fs.renameSync(real, a); fs.renameSync(a, real);
            fs.renameSync(link, a); fs.renameSync(a, link);
          }
          `,
          a,
          real,
          link,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          swapper.once('error', reject);
          swapper.once('exit', (code) => reject(new Error(`swapper exited early (${String(code)})`)));
          swapper.stdout!.once('data', () => resolve());
        });

        const counts = { inside: 0, absent: 0, other: 0 };
        const deadline = Date.now() + 15_000;
        let i = 0;
        for (; i < 20_000 && Date.now() < deadline; i++) {
          const r = await readConfinedUserFiles(root, 'a/b/file.txt');
          const body = text(r);
          expect(body).not.toContain(SECRET);
          if (r.kind === 'file' && body === 'inside') counts.inside++;
          else if (r.kind === 'absent') counts.absent++;
          else counts.other++;
        }
        // The swapper really did interleave with the reads: we saw both the
        // real file and a missing/linked `a`. Without both, the test proved
        // nothing about the race.
        expect(i).toBeGreaterThanOrEqual(5_000);
        expect(counts.inside).toBeGreaterThan(0);
        expect(counts.absent).toBeGreaterThan(0);
        expect(counts.other).toBe(0);
      } finally {
        // Wait for it to die, so the cleanup's rm isn't racing its renames.
        const exited = new Promise((resolve) => swapper.once('exit', resolve));
        swapper.kill('SIGKILL');
        if (swapper.exitCode === null && swapper.signalCode === null) await exited;
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// A BROKEN READ IS NOT AN ABSENCE (TASK-403).
//
// `absent` used to swallow the storage failing as well as the path being
// missing, and the two travel to completely different places: an absence is
// drawn as "this agent has not written anything here", an error as "we could
// not look, try again". Getting them the same way round is a confident, false
// claim about somebody's agent, manufactured out of an NFS export having a bad
// day.
//
// The errno is injected rather than provoked. A real `EIO` is not something a
// test can arrange, and the alternatives that ARE arrangeable — `chmod 000` —
// do nothing when the suite runs as root in a container, which is how this
// would quietly stop testing anything. The injection points are the calls the
// walk makes: `fs.open` for the root and every component, `fs.opendir` for a
// listing, and the leaf handle's own `stat` and `read`.
// ---------------------------------------------------------------------------

/** A rejection shaped like the ones Node's fs hands back: the name, and the number negated. */
function errno(code: string): NodeJS.ErrnoException {
  if (code === 'ESTALE') {
    throw new Error("Node never reports ESTALE by name on Linux, so errno('ESTALE') tests nothing: use stale()");
  }
  const err: NodeJS.ErrnoException = new Error(`simulated ${code}`);
  err.code = code;
  err.errno = -os.constants.errno[code as keyof typeof os.constants.errno];
  return err;
}

/**
 * ESTALE the way Node 24 really rejects with it on Linux, as measured on a real
 * NFS export: libuv has no name for errno 116, so `code` is its fallback text
 * and only `errno` carries the number.
 */
function stale(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('Unknown system error -116');
  err.code = 'Unknown system error -116';
  err.errno = -116;
  return err;
}

/**
 * Make the walk's opens of paths `match` picks reject with `err` (an errno
 * name, or a factory). Every other open is real.
 */
function failOpen(match: (p: string) => boolean, err: string | (() => Error)): void {
  const realOpen = fs.open;
  const make = typeof err === 'string' ? () => errno(err) : err;
  vi.spyOn(fs, 'open').mockImplementation((p, flags, mode) =>
    match(String(p)) ? Promise.reject(make()) : realOpen(p, flags, mode),
  );
}

/**
 * Let every open through to the real `fs.open`, and hand the leaf handle the
 * walk opens for `hello.txt` (always as `/proc/self/fd/<n>/hello.txt`) to
 * `rig` before the walk gets it.
 */
function rigLeaf(rig: (fh: fs.FileHandle) => void): void {
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
    const fh = await realOpen(p, flags, mode);
    if (String(p).endsWith('/hello.txt')) rig(fh);
    return fh;
  });
}

describe.skipIf(!ON_LINUX)(`a read that FAILED is never reported as an absence (${SKIP_REASON})`, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a listing that raises EIO throws rather than answering an empty dir', async () => {
    vi.spyOn(fs, 'opendir').mockRejectedValue(errno('EIO'));
    const out = readConfinedUserFiles(root, undefined);
    await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(out).rejects.toMatchObject({ code: 'EIO' });
  });

  it('a listing that raises EACCES throws too', async () => {
    vi.spyOn(fs, 'opendir').mockRejectedValue(errno('EACCES'));
    const out = readConfinedUserFiles(root, 'docs');
    await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(out).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('but a directory that VANISHED mid-read is still an absence', async () => {
    // The agent deleting its own folder between our open and our listing is
    // an ordinary race, not a failure, and it has always been `absent`.
    vi.spyOn(fs, 'opendir').mockRejectedValue(errno('ENOENT'));
    expect(await readConfinedUserFiles(root, 'docs')).toEqual({ kind: 'absent' });
  });

  it('a file read that raises EIO throws rather than answering absent', async () => {
    rigLeaf((fh) => {
      vi.spyOn(fh, 'read').mockRejectedValue(errno('EIO'));
    });
    const out = readConfinedUserFiles(root, 'hello.txt');
    await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(out).rejects.toMatchObject({ code: 'EIO' });
  });

  it('throws after a partial read followed by EIO instead of returning the prefix', async () => {
    let leaf: fs.FileHandle | undefined;
    rigLeaf((fh) => {
      leaf = fh;
      vi.spyOn(fh, 'read')
        .mockResolvedValueOnce({ bytesRead: 1, buffer: Buffer.from('h') })
        .mockRejectedValueOnce(errno('EIO'));
      vi.spyOn(fh, 'close');
    });
    const result = readConfinedUserFiles(root, 'hello.txt');
    await expect(result).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(result).rejects.toMatchObject({ code: 'EIO' });
    expect(leaf?.read).toHaveBeenCalledTimes(2);
    expect(leaf?.close).toHaveBeenCalledOnce();
  });

  it('SECURITY: ELOOP stays an absence — that is O_NOFOLLOW doing its job', async () => {
    /*
      The leaf is a symlink at the instant we open it. We refuse to follow
      it, and a path we refuse to follow is a path this surface does not have.
      Turning THIS into an error would hand a prober a way to tell "I planted
      a link here" from "nothing is here".
    */
    failOpen((p) => p.endsWith('/hello.txt'), 'ELOOP');
    expect(await readConfinedUserFiles(root, 'hello.txt')).toEqual({
      kind: 'absent',
    });
  });

  it('an unreachable ROOT throws — the whole mount being down is not an empty agent', async () => {
    /*
      The production shape of this bug. The export goes away, opening the
      agent's own subtree fails with `ESTALE`, and every read answers `absent`
      — so the Files tab tells everyone their agents have written nothing.
    */
    failOpen((p) => p === root, stale);
    const out = readConfinedUserFiles(root, undefined);
    await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(out).rejects.toMatchObject({ code: 'ESTALE', depth: -1 });
  });

  // ESTALE is NFS saying a handle the walk holds names something that is gone.
  // That is also what an export that is itself stale says, and on real NFS a
  // stale export fails a deep read at depth 1 or 0 before it ever fails at the
  // root. So ESTALE is a broken read at every depth, never an absence. Every
  // ESTALE here is stale(): the shape Node really reports.

  it.each([
    ['opening a folder on the path', (p: string) => p.endsWith('/docs'), 0],
    ['opening the leaf', (p: string) => p.endsWith('/note.md'), 1],
  ])('ESTALE %s is a broken read, not an absence', async (_what, match, depth) => {
    failOpen(match, stale);
    const out = readConfinedUserFiles(root, 'docs/note.md');
    await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(out).rejects.toMatchObject({ code: 'ESTALE', depth });
  });

  it('ESTALE listing a folder, or the root, throws too', async () => {
    vi.spyOn(fs, 'opendir').mockRejectedValue(stale());
    for (const [rel, depth] of [['docs', 0], [undefined, -1]] as const) {
      const out = readConfinedUserFiles(root, rel);
      await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
      await expect(out).rejects.toMatchObject({ code: 'ESTALE', depth });
    }
  });

  it('but a root that was never CREATED is an absence, not an error', async () => {
    /*
      The other half, and the common one: an agent that has never run has no
      subtree on the export yet. `ENOENT` on the root is exactly "this agent
      has written nothing", which is the one claim this surface is allowed to
      make about an agent.
    */
    const neverWritten = path.join(tmp, 'agent-who-never-ran');
    expect(await readConfinedUserFiles(neverWritten, undefined)).toEqual({
      kind: 'absent',
    });
  });

  it('a leaf stat that raises EIO throws; one that raises ENOENT does not', async () => {
    let code = 'EIO';
    rigLeaf((fh) => {
      vi.spyOn(fh, 'stat').mockRejectedValueOnce(errno(code));
    });
    const out = readConfinedUserFiles(root, 'hello.txt');
    await expect(out).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(out).rejects.toMatchObject({ code: 'EIO' });
    code = 'ENOENT';
    expect(await readConfinedUserFiles(root, 'hello.txt')).toEqual({
      kind: 'absent',
    });
  });

  it('SECURITY: a path outside the root is still a plain absence, never an error', async () => {
    /*
      Unchanged, and load-bearing. Confinement failures are the path-dependent
      answers, and a distinguishing one there is a free oracle for mapping
      another tenant's subtree. Only failures inside a directory the walk has
      already proved is ours are allowed to be loud.
    */
    const sibling = path.join(tmp, 'agent-b');
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'secret.txt'), 'nope');
    await fs.symlink(sibling, path.join(root, 'escape'));
    expect(await readConfinedUserFiles(root, 'escape/secret.txt')).toEqual({
      kind: 'absent',
    });
  });
});
