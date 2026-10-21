import { spawnSync } from 'node:child_process';
import { constants, existsSync, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSystemErrorName } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFilesReadError } from '../index.js';
import {
  MAX_WALK_ENTRIES,
  MAX_WALK_LIMIT_BYTES,
  MAX_WALK_PARTS,
  MAX_WALK_SKIPPED,
  WalkPathError,
  readConfinedByWalk,
  splitRelPath,
  type WalkReadOutput,
} from '../walk-read.js';

// ---------------------------------------------------------------------------
// The component walk behind the /files reader (TASK-899; first built in W3b).
//
// `readConfinedByWalk` opens every path component relative to the previous
// component's descriptor, with O_NOFOLLOW, through /proc/self/fd. That is a
// Linux-only mechanism, so everything that touches the disk is skipped where
// /proc is missing (a macOS laptop) — and runs in CI, which is ubuntu-latest.
// A skip there is not a pass. The lexical half (`splitRelPath`, the part and
// limit guards) and the off-Linux refusal run everywhere.
//
// Every SECURITY case is a thing an untrusted agent can do inside its own
// subtree, which it writes freely: plant a symlink at any depth, aimed outside
// the subtree or inside it, and plant a FIFO. The third thing, swapping a
// directory for a link mid-read, is tested once, through
// `readConfinedUserFiles`, in confined-read.test.ts.
// ---------------------------------------------------------------------------

// The walk's platform guard asks `existsSync('/proc/self/fd')`. This mock
// passes every call through to the real one, so one test can report procfs
// missing on a host that has it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const SKIP_REASON = 'needs Linux /proc/self/fd (runs in CI on ubuntu-latest)';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const LIMITS = { limitBytes: 1024, maxEntries: 100 };
const SECRET = 'SECRET-do-not-return';

const text = (r: WalkReadOutput): string =>
  r.kind === 'file' ? Buffer.from(r.contents).toString('utf8') : '';

describe('splitRelPath', () => {
  it('turns the empty path into the root', () => {
    expect(splitRelPath('')).toEqual([]);
  });

  it('splits a relative path on /', () => {
    expect(splitRelPath('docs/note.md')).toEqual(['docs', 'note.md']);
  });

  it.each([
    ['..'],
    ['a/../b'],
    ['/abs'],
    ['/'],
    ['a//b'],
    ['a/./b'],
    ['.'],
    ['a/'],
    ['a\0b'],
  ])('SECURITY: refuses %j with a typed invalid-path error', (rel) => {
    let caught: unknown;
    try {
      splitRelPath(rel);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WalkPathError);
    expect((caught as WalkPathError).code).toBe('invalid-path');
  });

  it('refuses more than MAX_WALK_PARTS segments', () => {
    const ok = Array.from({ length: MAX_WALK_PARTS }, (_, i) => `d${i}`).join('/');
    expect(splitRelPath(ok)).toHaveLength(MAX_WALK_PARTS);
    const tooMany = Array.from({ length: MAX_WALK_PARTS + 1 }, (_, i) => `d${i}`).join('/');
    expect(() => splitRelPath(tooMany)).toThrow(WalkPathError);
  });
});

describe('readConfinedByWalk — lexical guard', () => {
  it.each([[['..']], [['']], [['.']], [['a/b']], [['a\0']]])(
    'SECURITY: refuses part list %j before touching the disk',
    async (parts) => {
      await expect(readConfinedByWalk('/nonexistent-root', parts, LIMITS)).rejects.toBeInstanceOf(
        WalkPathError,
      );
    },
  );

  it('refuses more than MAX_WALK_PARTS parts', async () => {
    const parts = Array.from({ length: MAX_WALK_PARTS + 1 }, () => 'd');
    await expect(readConfinedByWalk('/nonexistent-root', parts, LIMITS)).rejects.toBeInstanceOf(
      WalkPathError,
    );
  });

  // Resource caps: a caller can't ask for an unbounded read or listing.
  it.each([
    [{ limitBytes: -1, maxEntries: 10 }],
    [{ limitBytes: 1.5, maxEntries: 10 }],
    [{ limitBytes: MAX_WALK_LIMIT_BYTES + 1, maxEntries: 10 }],
    [{ limitBytes: 10, maxEntries: 0 }],
    [{ limitBytes: 10, maxEntries: MAX_WALK_ENTRIES + 1 }],
  ])('refuses out-of-range limits %j before touching the disk', async (limits) => {
    await expect(readConfinedByWalk('/nonexistent-root', ['a'], limits)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('readConfinedByWalk — off Linux', () => {
  // Without /proc every component open is ENOENT, so a walk that ran anyway
  // would answer `absent` for everything: a Files tab that says the agent
  // wrote nothing, on a box where nothing could be read. The platform is
  // stubbed so this runs, and has teeth, on Linux CI too.
  it('off Linux it refuses with unsupported-platform instead of answering', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-walk-os-')));
    await fs.writeFile(path.join(tmp, 'x'), 'a real file the walk must not answer for');
    const d = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...d, value: 'darwin' });
    try {
      await expect(readConfinedByWalk(tmp, ['x'], LIMITS)).rejects.toMatchObject({
        name: 'WalkReadError',
        code: 'unsupported-platform',
        depth: -1,
      });
      // A storage-failure subclass, so a caller's one `UserFilesReadError`
      // branch catches it too.
      await expect(readConfinedByWalk(tmp, ['x'], LIMITS)).rejects.toBeInstanceOf(
        UserFilesReadError,
      );
    } finally {
      Object.defineProperty(process, 'platform', d);
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('a Linux host without /proc refuses the same way, instead of answering absent', async () => {
    // Without procfs every component open is ENOENT there too. The platform
    // reads 'linux' and only /proc/self/fd is reported missing, so this runs,
    // and has teeth, on macOS and on Linux CI alike.
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-walk-proc-')));
    await fs.writeFile(path.join(tmp, 'x'), 'a real file the walk must not answer for');
    const { existsSync: realExistsSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const d = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...d, value: 'linux' });
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === '/proc/self/fd' ? false : realExistsSync(p),
    );
    try {
      await expect(readConfinedByWalk(tmp, ['x'], LIMITS)).rejects.toMatchObject({
        name: 'WalkReadError',
        code: 'unsupported-platform',
        depth: -1,
      });
    } finally {
      vi.mocked(existsSync).mockImplementation(realExistsSync);
      Object.defineProperty(process, 'platform', d);
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe.skipIf(!ON_LINUX)(`readConfinedByWalk — on disk (${SKIP_REASON})`, () => {
  let tmp: string;
  /** The agent's own subtree: the trusted root a request may read. */
  let root: string;
  /** Somewhere the agent's subtree must never reach (another tenant's files). */
  let outside: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-walk-')));
    root = path.join(tmp, 'agent-a');
    outside = path.join(tmp, 'outside');
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'hello.txt'), 'be kind');
    await fs.writeFile(path.join(root, 'docs', 'note.md'), 'all good');
    await fs.mkdir(path.join(outside, 'b'), { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), SECRET);
    await fs.writeFile(path.join(outside, 'b', 'file.txt'), SECRET);
  });

  afterEach(async () => {
    // A test may have dropped read permission on a directory; restore it so
    // the cleanup can descend.
    await fs.chmod(path.join(root, 'docs'), 0o755).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reads a file', async () => {
    const r = await readConfinedByWalk(root, ['hello.txt'], LIMITS);
    expect(r).toMatchObject({ kind: 'file', truncated: false });
    expect(text(r)).toBe('be kind');
  });

  it('reads a nested file', async () => {
    const r = await readConfinedByWalk(root, ['docs', 'note.md'], LIMITS);
    expect(text(r)).toBe('all good');
  });

  it('lists the root itself for an empty part list', async () => {
    const r = await readConfinedByWalk(path.join(root, 'docs'), [], LIMITS);
    expect(r).toEqual({
      kind: 'dir',
      entries: [{ name: 'note.md', kind: 'file' }],
      truncated: false,
    });
  });

  it('lists the agent root: names and kinds only, nothing else', async () => {
    const r = await readConfinedByWalk(root, [], LIMITS);
    if (r.kind !== 'dir') throw new Error(`expected dir, got ${r.kind}`);
    const sorted = [...r.entries].sort((x, y) => x.name.localeCompare(y.name));
    expect({ ...r, entries: sorted }).toEqual({
      kind: 'dir',
      entries: [
        { name: 'docs', kind: 'dir' },
        { name: 'hello.txt', kind: 'file' },
      ],
      truncated: false,
    });
  });

  it('the root itself may be a symlink: it is trusted configuration, not agent-written', async () => {
    // An operator's mount path can be reached through a link. Only the parts
    // below the root are agent-written, and only those are opened O_NOFOLLOW.
    const via = path.join(tmp, 'mount');
    await fs.symlink(root, via);
    expect(text(await readConfinedByWalk(via, ['docs', 'note.md'], LIMITS))).toBe('all good');
    const r = await readConfinedByWalk(via, [], LIMITS);
    expect(r.kind === 'dir' && r.entries.map((e) => e.name).sort()).toEqual([
      'docs',
      'hello.txt',
    ]);
  });

  it('a missing path is absent', async () => {
    expect(await readConfinedByWalk(root, ['nope.md'], LIMITS)).toMatchObject({
      kind: 'absent',
      reason: 'missing',
    });
    expect(await readConfinedByWalk(root, ['missing', 'a', 'b'], LIMITS)).toMatchObject({
      kind: 'absent',
      reason: 'missing',
    });
  });

  it('a file used as a directory is absent', async () => {
    expect(await readConfinedByWalk(root, ['hello.txt', 'x'], LIMITS)).toMatchObject({
      kind: 'absent',
      reason: 'link-or-not-dir',
    });
  });

  describe('limits', () => {
    it('a file of exactly limitBytes is whole', async () => {
      await fs.writeFile(path.join(root, 'exact.bin'), Buffer.alloc(1024, 0x61));
      const r = await readConfinedByWalk(root, ['exact.bin'], LIMITS);
      expect(r).toMatchObject({ kind: 'file', truncated: false });
      expect(r.kind === 'file' && r.contents.byteLength).toBe(1024);
    });

    it('a file of limitBytes + 1 is truncated to limitBytes', async () => {
      await fs.writeFile(path.join(root, 'over.bin'), Buffer.alloc(1025, 0x61));
      const r = await readConfinedByWalk(root, ['over.bin'], LIMITS);
      expect(r).toMatchObject({ kind: 'file', truncated: true });
      expect(r.kind === 'file' && r.contents.byteLength).toBe(1024);
    });

    it('a directory listing is capped at maxEntries and says so', async () => {
      const many = path.join(root, 'many');
      await fs.mkdir(many);
      for (let i = 0; i < 5; i++) await fs.writeFile(path.join(many, `f${i}`), 'x');
      const capped = await readConfinedByWalk(root, ['many'], { limitBytes: 10, maxEntries: 3 });
      expect(capped).toMatchObject({ kind: 'dir', truncated: true });
      expect(capped.kind === 'dir' && capped.entries).toHaveLength(3);
      const exact = await readConfinedByWalk(root, ['many'], { limitBytes: 10, maxEntries: 5 });
      expect(exact).toMatchObject({ kind: 'dir', truncated: false });
      expect(exact.kind === 'dir' && exact.entries).toHaveLength(5);
    });
  });

  describe('SECURITY: symlinks are never followed', () => {
    it('a symlink leaf to an outside secret is absent', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
      const r = await readConfinedByWalk(root, ['leak.txt'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('a relative symlink leaf inside the agent root is absent too', async () => {
      await fs.symlink('hello.txt', path.join(root, 'alias.md'));
      expect(await readConfinedByWalk(root, ['alias.md'], LIMITS)).toMatchObject({
        kind: 'absent',
        reason: 'link-or-not-dir',
      });
    });

    it('a symlinked intermediate directory is absent', async () => {
      await fs.symlink(outside, path.join(root, 'a'));
      const r = await readConfinedByWalk(root, ['a', 'b', 'file.txt'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('a symlinked intermediate that stays inside the agent root is absent too', async () => {
      // Where a link points is never looked at. A walk that followed links
      // which happen to land inside the subtree would have to resolve them
      // first, and resolve-then-open is the window this reader exists to close.
      await fs.symlink('docs', path.join(root, 'alias'));
      expect(await readConfinedByWalk(root, ['alias', 'note.md'], LIMITS)).toMatchObject({
        kind: 'absent',
        reason: 'link-or-not-dir',
      });
    });

    it('a symlinked directory as the leaf is absent (not listed)', async () => {
      await fs.symlink(outside, path.join(root, 'a'));
      const r = await readConfinedByWalk(root, ['a'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
    });

    it('a symlink as the first component is absent', async () => {
      await fs.symlink(outside, path.join(root, 'evil'));
      expect(await readConfinedByWalk(root, ['evil'], LIMITS)).toMatchObject({ kind: 'absent' });
      const r = await readConfinedByWalk(root, ['evil', 'secret.txt'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('a symlink in a directory is omitted from its listing', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
      await fs.symlink(outside, path.join(root, 'leakdir'));
      await fs.symlink('/nonexistent', path.join(root, 'dangling'));
      const r = await readConfinedByWalk(root, [], LIMITS);
      if (r.kind !== 'dir') throw new Error(`expected dir, got ${r.kind}`);
      expect(r.entries.map((e) => e.name).sort()).toEqual(['docs', 'hello.txt']);
    });
  });

  describe('SECURITY: special files', () => {
    // mkfifo is coreutils, so on the Linux boxes these run on a failure is a
    // broken fixture, not a reason to pass quietly.
    const mkfifo = (p: string): void => {
      expect(spawnSync('mkfifo', [p]).status, `mkfifo ${p}`).toBe(0);
    };

    it('a FIFO leaf does not block and is not read', async () => {
      mkfifo(path.join(root, 'pipe'));
      // If the open blocked, this would hang until the test timeout — a FIFO
      // with no writer blocks an O_RDONLY open forever without O_NONBLOCK.
      const r = await readConfinedByWalk(root, ['pipe'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'not-file-or-dir' });
    });

    it('a FIFO as an intermediate component does not block', async () => {
      mkfifo(path.join(root, 'pipe'));
      expect(await readConfinedByWalk(root, ['pipe', 'x'], LIMITS)).toMatchObject({
        kind: 'absent',
      });
    });

    it('a FIFO is omitted from a listing', async () => {
      mkfifo(path.join(root, 'pipe'));
      const r = await readConfinedByWalk(root, [], LIMITS);
      expect(r.kind === 'dir' && r.entries.map((e) => e.name).sort()).toEqual([
        'docs',
        'hello.txt',
      ]);
    });

    it('a Unix socket leaf is absent, not an error', async () => {
      // open(2) refuses a socket outright (ENXIO): a special file, not a
      // storage failure.
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path.join(root, 'sock'), resolve);
      });
      try {
        expect(await readConfinedByWalk(root, ['sock'], LIMITS)).toMatchObject({
          kind: 'absent',
          reason: 'not-file-or-dir',
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('a device leaf is absent', async () => {
      // /dev/null is a character device; reach it as the root's child so the
      // test needs no mknod privilege.
      expect(await readConfinedByWalk('/dev', ['null'], LIMITS)).toMatchObject({
        kind: 'absent',
        reason: 'not-file-or-dir',
      });
    });
  });

  describe('search-only directories', () => {
    it.skipIf(IS_ROOT)('walks THROUGH a directory it may search but not read', async () => {
      // Owner has write+search but no read (0311): an agent can make a folder
      // like that. Passing through it needs search permission only, the reach
      // a plain path lookup always had.
      await fs.chmod(path.join(root, 'docs'), 0o311);
      const r = await readConfinedByWalk(root, ['docs', 'note.md'], LIMITS);
      expect(text(r)).toBe('all good');
      // ...but cannot LIST it: that is a refusal, not an absence.
      await expect(readConfinedByWalk(root, ['docs'], LIMITS)).rejects.toMatchObject({
        code: 'EACCES',
      });
    });
  });

  // ESTALE: on NFS a handle the walk holds can name a directory that is gone,
  // because the agent replaced or deleted it and this host's NFS cache still
  // holds the old one. The walk then walks once more, opening the root and
  // every directory on the way O_RDONLY, which NFS revalidates with the
  // server, and that answer stands. Proven on a real NFSv3 export (TASK-899);
  // here the ESTALE is injected, and these pin the mechanism.
  describe('ESTALE: one retry, from scratch, with opens NFS revalidates', () => {
    const { O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;
    /** Linux's value on x86_64 and arm64; Node's fs.constants leaves it out. */
    const O_PATH = 0o10000000;

    /**
     * ESTALE the way Node 24 really rejects with it on Linux, as measured on a
     * real NFS export: libuv has no name for errno 116, so `code` is its
     * fallback text and only `errno` carries the number.
     */
    function stale(): NodeJS.ErrnoException {
      const err: NodeJS.ErrnoException = new Error('Unknown system error -116');
      err.code = 'Unknown system error -116';
      err.errno = -116;
      return err;
    }

    /**
     * Spy on the walk's opens. Records each one's name ('<root>' for the root)
     * and flags, and makes the first `times` opens of `name` reject with
     * stale(), each after running `act`, the agent's move.
     */
    function staleOpens(name: string, times: number, act?: () => Promise<unknown>): Array<[string, number]> {
      const opens: Array<[string, number]> = [];
      const realOpen = fs.open;
      let left = times;
      vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
        const opened = String(p) === root ? '<root>' : path.basename(String(p));
        opens.push([opened, Number(flags)]);
        if (opened === name && left > 0) {
          left--;
          await act?.();
          throw stale();
        }
        return realOpen(p, flags, mode);
      });
      return opens;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('the injected error is the shape Node gives ESTALE here', () => {
      // If Node ever names errno 116 itself, its `code` will say ESTALE and
      // stale() is out of date.
      expect(os.constants.errno.ESTALE).toBe(116);
      expect(getSystemErrorName(-116)).toBe('Unknown system error -116');
    });

    it('a stale handle is reported as ESTALE, a name Node does not give it', async () => {
      staleOpens('docs', Infinity);
      const out = readConfinedByWalk(root, ['docs', 'note.md'], LIMITS);
      await expect(out).rejects.toMatchObject({ name: 'WalkReadError', code: 'ESTALE', depth: 0 });
      await expect(out).rejects.toThrow('could not open a path component (ESTALE)');
    });

    it('retries once from scratch, opening the root and each directory on the way O_RDONLY', async () => {
      const opens = staleOpens('docs', 1);
      expect(text(await readConfinedByWalk(root, ['docs', 'note.md'], LIMITS))).toBe('all good');
      expect(opens).toEqual([
        // The first walk, the one W3b proved on real NFS: O_PATH to pass through.
        ['<root>', O_DIRECTORY | O_PATH],
        ['docs', O_NOFOLLOW | O_PATH | O_DIRECTORY],
        // The retry: O_RDONLY, which makes NFS check each directory with the
        // server. Still O_NOFOLLOW below the root.
        ['<root>', O_DIRECTORY | O_RDONLY],
        ['docs', O_NOFOLLOW | O_RDONLY | O_DIRECTORY],
        ['note.md', O_NOFOLLOW | O_RDONLY | O_NONBLOCK],
      ]);
    });

    /** Make the first read of the first `name` leaf the walk opens reject with stale(). */
    function staleRead(name: string): void {
      const realOpen = fs.open;
      let rigged = false;
      vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
        const fh = await realOpen(p, flags, mode);
        if (!rigged && path.basename(String(p)) === name) {
          rigged = true;
          vi.spyOn(fh, 'read').mockRejectedValueOnce(stale());
        }
        return fh;
      });
    }

    const answer = (r: WalkReadOutput): string =>
      r.kind === 'file'
        ? `file:${text(r)}`
        : r.kind === 'dir'
          ? `dir:${r.entries.map((e) => e.name).join(',')}`
          : `absent:${r.reason}`;

    it.each([
      ['opening the root', ['docs', 'note.md'], 'file:all good', () => staleOpens('<root>', 1)],
      ['opening the leaf', ['docs', 'note.md'], 'file:all good', () => staleOpens('note.md', 1)],
      ['reading the leaf', ['docs', 'note.md'], 'file:all good', () => staleRead('note.md')],
      ['listing a directory', ['docs'], 'dir:note.md', () => vi.spyOn(fs, 'opendir').mockRejectedValueOnce(stale())],
    ])('ESTALE %s is retried too, and the retry answers', async (_what, parts, expected, inject) => {
      inject();
      expect(answer(await readConfinedByWalk(root, parts, LIMITS))).toBe(expected);
    });

    it('ESTALE again on the retry throws: one retry, never two', async () => {
      const opens = staleOpens('docs', 2);
      await expect(readConfinedByWalk(root, ['docs', 'note.md'], LIMITS)).rejects.toMatchObject({
        name: 'WalkReadError',
        code: 'ESTALE',
        depth: 0,
      });
      // Only two opens of `docs` were stale, so a third walk would have read the file.
      expect(opens.filter(([opened]) => opened === 'docs')).toHaveLength(2);
    });

    it('only ESTALE is retried: an EIO that would not repeat still throws', async () => {
      // One EIO, then every open is real, so a reader that retried on any
      // WalkReadError would succeed on its second walk and hide the broken read.
      const realOpen = fs.open;
      let left = 1;
      vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
        if (left > 0 && path.basename(String(p)) === 'docs') {
          left--;
          throw Object.assign(new Error('simulated EIO'), { code: 'EIO', errno: -5 });
        }
        return realOpen(p, flags, mode);
      });
      await expect(readConfinedByWalk(root, ['docs', 'note.md'], LIMITS)).rejects.toMatchObject({
        name: 'WalkReadError',
        code: 'EIO',
        depth: 0,
      });
    });

    it('SECURITY: the retry does not open a FIFO on the path: O_DIRECTORY keeps it from blocking', async () => {
      // On the retry a directory is opened O_RDONLY, and an O_RDONLY open of a
      // FIFO without O_NONBLOCK waits for a writer: an agent could park the
      // host's request, and a libuv thread, forever. O_DIRECTORY refuses it
      // (ENOTDIR). If it ever blocked, the race below reports it quickly
      // instead of leaving the test to hang until its timeout.
      const pipe = path.join(root, 'docs', 'pipe');
      expect(spawnSync('mkfifo', [pipe]).status, `mkfifo ${pipe}`).toBe(0);
      staleOpens('docs', 1);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 3_000);
      });
      try {
        const out = await Promise.race([readConfinedByWalk(root, ['docs', 'pipe', 'x'], LIMITS), timedOut]);
        expect(out).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      } finally {
        clearTimeout(timer);
        // Let a parked open, if there is one, finish: a writer appears.
        await (await fs.open(pipe, constants.O_RDWR | O_NONBLOCK)).close();
      }
    });

    it('SECURITY: the retry opens a device on the path as a directory only, so never as a device', async () => {
      // /dev/null is harmless to open, but the same open of a tty or a FIFO is
      // not, so what is pinned is the flag: O_DIRECTORY on every open of it.
      const opens = staleOpens('null', 1);
      const r = await readConfinedByWalk('/dev', ['null', 'x'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      const ofNull = opens.filter(([opened]) => opened === 'null');
      expect(ofNull).toHaveLength(2);
      for (const [, flags] of ofNull) expect(flags & O_DIRECTORY).toBe(O_DIRECTORY);
    });

    it('SECURITY: the retry follows no symlink either: a folder swapped for a link out is absent', async () => {
      staleOpens('docs', 1, async () => {
        await fs.rm(path.join(root, 'docs'), { recursive: true });
        await fs.symlink(outside, path.join(root, 'docs'));
      });
      const r = await readConfinedByWalk(root, ['docs', 'secret.txt'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it.skipIf(IS_ROOT)(
      'on the retry, a search-only directory is a broken read (EACCES), never an absence',
      async () => {
        // O_RDONLY needs read permission, so the retry can't pass through a
        // 0311 directory the way the first walk does. That's the price of
        // making NFS look again, and it is paid only after an ESTALE.
        await fs.chmod(path.join(root, 'docs'), 0o311);
        staleOpens('note.md', 1);
        await expect(readConfinedByWalk(root, ['docs', 'note.md'], LIMITS)).rejects.toMatchObject({
          code: 'EACCES',
          depth: 0,
        });
      },
    );
  });
});

describe.skipIf(!ON_LINUX)(`readConfinedByWalk — resource caps (${SKIP_REASON})`, () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-walk-caps-')));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('stops a listing after MAX_WALK_SKIPPED skipped entries, flagged truncated', async () => {
    const dir = path.join(tmp, 'links');
    await fs.mkdir(dir);
    for (let i = 0; i < MAX_WALK_SKIPPED + 50; i++) {
      await fs.symlink('/etc/hostname', path.join(dir, `l${i}`));
    }
    const out = await readConfinedByWalk(tmp, ['links'], LIMITS);
    expect(out).toMatchObject({ kind: 'dir', entries: [], truncated: true });
  });

  it('a few skipped entries do not truncate the listing', async () => {
    const dir = path.join(tmp, 'mixed');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'a.md'), 'a');
    await fs.symlink('/etc/hostname', path.join(dir, 'link'));
    const out = await readConfinedByWalk(tmp, ['mixed'], LIMITS);
    expect(out).toMatchObject({ kind: 'dir', truncated: false });
    expect(out.kind === 'dir' && out.entries.map((e) => e.name)).toEqual(['a.md']);
  });

  it('a small file under a large limit reads whole and untruncated', async () => {
    await fs.writeFile(path.join(tmp, 'small.txt'), 'hello');
    const out = await readConfinedByWalk(tmp, ['small.txt'], {
      limitBytes: MAX_WALK_LIMIT_BYTES,
      maxEntries: 10,
    });
    expect(out).toMatchObject({ kind: 'file', truncated: false });
    expect(out.kind === 'file' && Buffer.from(out.contents).toString()).toBe('hello');
  });

  it('a 3 MiB file under a 2 MiB limit is a 2 MiB prefix, truncated', async () => {
    await fs.writeFile(path.join(tmp, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    const out = await readConfinedByWalk(tmp, ['big.bin'], {
      limitBytes: 2 * 1024 * 1024,
      maxEntries: 10,
    });
    expect(out).toMatchObject({ kind: 'file', truncated: true });
    expect(out.kind === 'file' && out.contents.length).toBe(2 * 1024 * 1024);
  });

  it('a file that grew after its stat is read to the end, or to the limit', async () => {
    // The read's first buffer is sized from the leaf's stat, so a file that
    // grew between the stat and the read starts in a buffer that is too small,
    // and the buffer has to grow. The leaf's stat is rigged to say 1 byte.
    const body = Buffer.from('0123456789'.repeat(100));
    await fs.writeFile(path.join(tmp, 'grown.txt'), body);
    const realOpen = fs.open;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
      const fh = await realOpen(p, flags, mode);
      if (String(p).endsWith('/grown.txt')) {
        const realStat = fh.stat.bind(fh);
        vi.spyOn(fh, 'stat').mockImplementation(async () => Object.assign(await realStat(), { size: 1 }));
      }
      return fh;
    });
    try {
      const whole = await readConfinedByWalk(tmp, ['grown.txt'], { limitBytes: 4096, maxEntries: 10 });
      expect(whole).toMatchObject({ kind: 'file', truncated: false });
      expect(whole.kind === 'file' && Buffer.from(whole.contents).equals(body)).toBe(true);
      const capped = await readConfinedByWalk(tmp, ['grown.txt'], { limitBytes: 100, maxEntries: 10 });
      expect(capped).toMatchObject({ kind: 'file', truncated: true });
      expect(capped.kind === 'file' && Buffer.from(capped.contents).equals(body.subarray(0, 100))).toBe(true);
    } finally {
      open.mockRestore();
    }
  });
});
