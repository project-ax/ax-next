import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
// The component walk (W3b, Task 1).
//
// `readConfinedByWalk` opens every path component relative to the previous
// component's descriptor, with O_NOFOLLOW, through /proc/<pid>/fd. That is a
// Linux-only mechanism, so everything that touches the disk is skipped where
// /proc is missing (a macOS laptop) — and runs in CI, which is ubuntu-latest.
// The lexical half (`splitRelPath`) runs everywhere.
//
// Every SECURITY case is a thing an untrusted agent can do inside a shared
// folder it writes freely: plant a symlink at any depth, plant a FIFO, and
// swap a directory for a link while we are mid-walk.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const SKIP_REASON = 'needs Linux /proc/<pid>/fd (runs in CI on ubuntu-latest)';
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
    expect(splitRelPath('memory/status.md')).toEqual(['memory', 'status.md']);
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

describe.skipIf(!ON_LINUX)(`readConfinedByWalk — on disk (${SKIP_REASON})`, () => {
  let tmp: string;
  /** The trusted root (the export mount). */
  let root: string;
  /** A shared folder inside it. */
  let folder: string;
  /** Somewhere the folder must never reach. */
  let outside: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-walk-')));
    root = path.join(tmp, 'export');
    folder = path.join(root, '.shared', 'sf_x');
    outside = path.join(tmp, 'outside');
    await fs.mkdir(path.join(folder, 'memory'), { recursive: true });
    await fs.writeFile(path.join(folder, 'instructions.md'), 'be kind');
    await fs.writeFile(path.join(folder, 'memory', 'status.md'), 'all good');
    await fs.mkdir(path.join(outside, 'b'), { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), SECRET);
    await fs.writeFile(path.join(outside, 'b', 'file.txt'), SECRET);
  });

  afterEach(async () => {
    // A test may have dropped read permission on a directory; restore it so
    // the cleanup can descend.
    await fs.chmod(path.join(root, '.shared'), 0o755).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reads a file', async () => {
    const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'instructions.md'], LIMITS);
    expect(r).toMatchObject({ kind: 'file', truncated: false, size: 7 });
    expect(text(r)).toBe('be kind');
  });

  it('reads a nested file', async () => {
    const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'memory', 'status.md'], LIMITS);
    expect(text(r)).toBe('all good');
  });

  it('lists a directory: files carry size + updatedAt, dirs do not', async () => {
    const r = await readConfinedByWalk(root, ['.shared', 'sf_x'], LIMITS);
    if (r.kind !== 'dir') throw new Error(`expected dir, got ${r.kind}`);
    expect(r.truncated).toBe(false);
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['instructions.md', 'memory']);
    expect(byName['memory']).toEqual({ name: 'memory', kind: 'dir' });
    expect(byName['instructions.md']).toMatchObject({ kind: 'file', size: 7 });
    expect(Number.isNaN(Date.parse(byName['instructions.md']!.updatedAt!))).toBe(false);
  });

  it('lists the root itself for an empty part list', async () => {
    const r = await readConfinedByWalk(path.join(root, '.shared', 'sf_x', 'memory'), [], LIMITS);
    expect(r).toMatchObject({ kind: 'dir', entries: [{ name: 'status.md', kind: 'file' }] });
  });

  it('a missing path is absent', async () => {
    expect(await readConfinedByWalk(root, ['.shared', 'sf_x', 'nope.md'], LIMITS)).toMatchObject({
      kind: 'absent',
      reason: 'missing',
    });
    expect(
      await readConfinedByWalk(root, ['.shared', 'sf_missing', 'a', 'b'], LIMITS),
    ).toMatchObject({ kind: 'absent', reason: 'missing' });
  });

  it('a file used as a directory is absent', async () => {
    expect(
      await readConfinedByWalk(root, ['.shared', 'sf_x', 'instructions.md', 'x'], LIMITS),
    ).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
  });

  describe('limits', () => {
    it('a file of exactly limitBytes is whole', async () => {
      await fs.writeFile(path.join(folder, 'exact.bin'), Buffer.alloc(1024, 0x61));
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'exact.bin'], LIMITS);
      expect(r).toMatchObject({ kind: 'file', truncated: false, size: 1024 });
      expect(r.kind === 'file' && r.contents.byteLength).toBe(1024);
    });

    it('a file of limitBytes + 1 is truncated to limitBytes', async () => {
      await fs.writeFile(path.join(folder, 'over.bin'), Buffer.alloc(1025, 0x61));
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'over.bin'], LIMITS);
      expect(r).toMatchObject({ kind: 'file', truncated: true, size: 1025 });
      expect(r.kind === 'file' && r.contents.byteLength).toBe(1024);
    });

    it('a directory listing is capped at maxEntries and says so', async () => {
      const many = path.join(folder, 'many');
      await fs.mkdir(many);
      for (let i = 0; i < 5; i++) await fs.writeFile(path.join(many, `f${i}`), 'x');
      const capped = await readConfinedByWalk(root, ['.shared', 'sf_x', 'many'], {
        limitBytes: 10,
        maxEntries: 3,
      });
      expect(capped).toMatchObject({ kind: 'dir', truncated: true });
      expect(capped.kind === 'dir' && capped.entries).toHaveLength(3);
      const exact = await readConfinedByWalk(root, ['.shared', 'sf_x', 'many'], {
        limitBytes: 10,
        maxEntries: 5,
      });
      expect(exact).toMatchObject({ kind: 'dir', truncated: false });
      expect(exact.kind === 'dir' && exact.entries).toHaveLength(5);
    });
  });

  describe('SECURITY: symlinks are never followed', () => {
    it('a symlink leaf to an outside secret is absent', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'leak.txt'));
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'leak.txt'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('a relative symlink leaf inside the folder is absent too', async () => {
      await fs.symlink('instructions.md', path.join(folder, 'alias.md'));
      expect(
        await readConfinedByWalk(root, ['.shared', 'sf_x', 'alias.md'], LIMITS),
      ).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
    });

    it('a symlinked intermediate directory is absent', async () => {
      await fs.symlink(outside, path.join(folder, 'a'));
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'a', 'b', 'file.txt'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('a symlinked directory as the leaf is absent (not listed)', async () => {
      await fs.symlink(outside, path.join(folder, 'a'));
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'a'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'link-or-not-dir' });
    });

    it('a symlink as the folder itself is absent', async () => {
      await fs.symlink(outside, path.join(root, '.shared', 'sf_evil'));
      expect(await readConfinedByWalk(root, ['.shared', 'sf_evil'], LIMITS)).toMatchObject({
        kind: 'absent',
      });
      expect(
        await readConfinedByWalk(root, ['.shared', 'sf_evil', 'secret.txt'], LIMITS),
      ).toMatchObject({ kind: 'absent' });
    });

    it('a symlink in a directory is omitted from its listing', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'leak.txt'));
      await fs.symlink(outside, path.join(folder, 'leakdir'));
      await fs.symlink('/nonexistent', path.join(folder, 'dangling'));
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x'], LIMITS);
      if (r.kind !== 'dir') throw new Error(`expected dir, got ${r.kind}`);
      expect(r.entries.map((e) => e.name).sort()).toEqual(['instructions.md', 'memory']);
    });
  });

  describe('SECURITY: special files', () => {
    const mkfifo = (p: string): boolean => spawnSync('mkfifo', [p]).status === 0;

    it('a FIFO leaf does not block and is not read', async () => {
      const fifo = path.join(folder, 'pipe');
      if (!mkfifo(fifo)) return; // no mkfifo on this box
      // If the open blocked, this would hang until the test timeout — a FIFO
      // with no writer blocks an O_RDONLY open forever without O_NONBLOCK.
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'pipe'], LIMITS);
      expect(r).toMatchObject({ kind: 'absent', reason: 'not-file-or-dir' });
    });

    it('a FIFO as an intermediate component does not block', async () => {
      const fifo = path.join(folder, 'pipe');
      if (!mkfifo(fifo)) return;
      expect(
        await readConfinedByWalk(root, ['.shared', 'sf_x', 'pipe', 'x'], LIMITS),
      ).toMatchObject({ kind: 'absent' });
    });

    it('a FIFO is omitted from a listing', async () => {
      if (!mkfifo(path.join(folder, 'pipe'))) return;
      const r = await readConfinedByWalk(root, ['.shared', 'sf_x'], LIMITS);
      expect(r.kind === 'dir' && r.entries.map((e) => e.name).sort()).toEqual([
        'instructions.md',
        'memory',
      ]);
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

  describe('search-only directories (.shared is 0711 in production)', () => {
    it.skipIf(IS_ROOT)(
      'walks THROUGH a directory it may search but not read',
      async () => {
        // Owner has write+search but no read: the same position the host
        // (uid 1000) is in against a root-owned 0711 `.shared`.
        await fs.chmod(path.join(root, '.shared'), 0o311);
        const r = await readConfinedByWalk(root, ['.shared', 'sf_x', 'instructions.md'], LIMITS);
        expect(text(r)).toBe('be kind');
        // ...but cannot LIST it: that is a refusal, not an absence.
        await expect(readConfinedByWalk(root, ['.shared'], LIMITS)).rejects.toMatchObject({
          code: 'EACCES',
        });
      },
    );
  });

  // -------------------------------------------------------------------------
  // THE RACE. A child process swaps `a` between a real directory and a symlink
  // to an outside directory with the same shape, as fast as it can, while this
  // process reads `a/b/file.txt` through the walk. A check-then-open reader
  // loses this race; a walk that pins each component's descriptor cannot,
  // because a symlink at `a` fails its O_NOFOLLOW open at the moment we look.
  // -------------------------------------------------------------------------
  it(
    'SECURITY: a directory swapped for a symlink mid-walk never yields the secret',
    async () => {
      const a = path.join(folder, 'a');
      const real = path.join(folder, 'a.real');
      const link = path.join(folder, 'a.link');
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
          swapper.once('exit', (code) => reject(new Error(`swapper exited early (${code})`)));
          swapper.stdout!.once('data', () => resolve());
        });

        const parts = ['.shared', 'sf_x', 'a', 'b', 'file.txt'];
        const counts = { inside: 0, absent: 0, other: 0 };
        const deadline = Date.now() + 15_000;
        let i = 0;
        for (; i < 20_000 && Date.now() < deadline; i++) {
          const r = await readConfinedByWalk(root, parts, LIMITS);
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
        swapper.kill('SIGKILL');
      }
    },
    30_000,
  );
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
    expect(out).toMatchObject({ kind: 'file', truncated: false, size: 5 });
    expect(out.kind === 'file' && Buffer.from(out.contents).toString()).toBe('hello');
  });

  it('a 3 MiB file under a 2 MiB limit is a 2 MiB prefix, truncated', async () => {
    await fs.writeFile(path.join(tmp, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    const out = await readConfinedByWalk(tmp, ['big.bin'], { limitBytes: 2 * 1024 * 1024, maxEntries: 10 });
    expect(out).toMatchObject({ kind: 'file', truncated: true, size: 3 * 1024 * 1024 });
    expect(out.kind === 'file' && out.contents.length).toBe(2 * 1024 * 1024);
  });
});
