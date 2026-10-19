import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_WALK_ENTRIES,
  MAX_WALK_PARTS,
  MAX_WALK_SKIPPED,
  WalkPathError,
  WalkReadError,
} from '../walk-read.js';
import { scanConfinedByWalk, type WalkScanOutput } from '../walk-scan.js';

// ---------------------------------------------------------------------------
// The recursive confined stat (W3d). Same mechanism as the reader, so the
// same split: the argument guards run everywhere, the disk runs where
// /proc/<pid>/fd exists (CI's ubuntu-latest, a Linux container).
//
// Every SECURITY case is something an agent can do in a folder it writes:
// plant a link to a directory outside, plant FIFOs, and swap a directory for
// a link while we are mid-scan.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const SKIP_REASON = 'needs Linux /proc/<pid>/fd (runs in CI on ubuntu-latest)';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const BASE = ['.shared', 'sf_x'];

const paths = (r: WalkScanOutput): string[] => (r.kind === 'done' ? r.files.map((f) => f.path) : []);
const openFds = (): number => readdirSync('/proc/self/fd').length;

describe('scanConfinedByWalk — argument guards', () => {
  it.each([[['..']], [['']], [['.']], [['a/b']], [['a\0']], [['/abs']]])(
    'SECURITY: refuses base parts %j before touching the disk',
    async (parts) => {
      await expect(scanConfinedByWalk('/nonexistent-root', parts)).rejects.toBeInstanceOf(
        WalkPathError,
      );
    },
  );

  it('refuses a base so deep its files would pass MAX_WALK_PARTS', async () => {
    const parts = Array.from({ length: MAX_WALK_PARTS }, () => 'd');
    await expect(scanConfinedByWalk('/nonexistent-root', parts)).rejects.toBeInstanceOf(
      WalkPathError,
    );
  });

  it.each([[0], [-1], [1.5], [MAX_WALK_ENTRIES + 1]])(
    'refuses maxEntries %j before touching the disk',
    async (maxEntries) => {
      await expect(
        scanConfinedByWalk('/nonexistent-root', BASE, { maxEntries }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );

  it.skipIf(ON_LINUX)('off Linux it is unsupported-platform, never an empty scan', async () => {
    await expect(scanConfinedByWalk(os.tmpdir(), [])).rejects.toMatchObject({
      code: 'unsupported-platform',
    });
  });
});

describe.skipIf(!ON_LINUX)(`scanConfinedByWalk — on disk (${SKIP_REASON})`, () => {
  let tmp: string;
  let root: string;
  let folder: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-scan-')));
    root = path.join(tmp, 'export');
    folder = path.join(root, ...BASE);
    outside = path.join(tmp, 'outside');
    await fs.mkdir(path.join(folder, 'memory', 'deep'), { recursive: true });
    await fs.writeFile(path.join(folder, 'instructions.md'), 'be kind');
    await fs.writeFile(path.join(folder, 'memory', 'status.md'), 'all good');
    await fs.writeFile(path.join(folder, 'memory', 'deep', 'x.txt'), 'x');
    await fs.mkdir(path.join(folder, 'empty'));
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
  });

  afterEach(async () => {
    await fs.chmod(path.join(root, '.shared'), 0o755).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reports every regular file, recursively, sorted, with size/mtimeMs/ino', async () => {
    const r = await scanConfinedByWalk(root, BASE);
    if (r.kind !== 'done') throw new Error(`expected done, got ${r.kind}`);
    expect(r.truncated).toBe(false);
    expect(paths(r)).toEqual(['instructions.md', 'memory/deep/x.txt', 'memory/status.md']);
    const st = await fs.lstat(path.join(folder, 'instructions.md'));
    expect(r.files[0]).toEqual({
      path: 'instructions.md',
      size: 7,
      mtimeMs: st.mtimeMs,
      ino: st.ino,
    });
  });

  it('is deterministic: two scans of an unchanged tree are equal', async () => {
    expect(await scanConfinedByWalk(root, BASE)).toEqual(await scanConfinedByWalk(root, BASE));
  });

  it('sees a rewrite: size and mtime change', async () => {
    const before = await scanConfinedByWalk(root, BASE);
    await fs.writeFile(path.join(folder, 'instructions.md'), 'be very kind');
    await fs.utimes(path.join(folder, 'instructions.md'), new Date(), new Date(Date.now() + 5000));
    const after = await scanConfinedByWalk(root, BASE);
    expect(after).not.toEqual(before);
    expect(after.kind === 'done' && after.files[0]!.size).toBe(12);
  });

  it('scans the root itself for an empty base', async () => {
    expect(paths(await scanConfinedByWalk(path.join(folder, 'memory'), []))).toEqual([
      'deep/x.txt',
      'status.md',
    ]);
  });

  it('an empty folder is done with no files', async () => {
    await fs.mkdir(path.join(root, '.shared', 'sf_empty'));
    expect(await scanConfinedByWalk(root, ['.shared', 'sf_empty'])).toEqual({
      kind: 'done',
      files: [],
      truncated: false,
    });
  });

  it('a missing folder (or .shared) is absent: missing', async () => {
    expect(await scanConfinedByWalk(root, ['.shared', 'sf_nope'])).toEqual({
      kind: 'absent',
      reason: 'missing',
    });
    await fs.mkdir(path.join(tmp, 'bare'));
    expect(await scanConfinedByWalk(path.join(tmp, 'bare'), ['.shared', 'sf_x'])).toEqual({
      kind: 'absent',
      reason: 'missing',
    });
  });

  it('a missing ROOT throws (trusted configuration is broken, not an absence)', async () => {
    await expect(scanConfinedByWalk(path.join(tmp, 'no-root'), BASE)).rejects.toMatchObject({
      code: 'ENOENT',
      depth: -1,
    });
  });

  describe('SECURITY: symlinks are never followed', () => {
    it('a planted symlink to a directory outside is not entered or reported', async () => {
      await fs.symlink(outside, path.join(folder, 'leakdir'));
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'leak.txt'));
      await fs.symlink('/nonexistent', path.join(folder, 'dangling'));
      const r = await scanConfinedByWalk(root, BASE);
      expect(paths(r)).toEqual(['instructions.md', 'memory/deep/x.txt', 'memory/status.md']);
      expect(JSON.stringify(r)).not.toContain('secret');
      expect(r).toMatchObject({ truncated: false });
    });

    it('a symlink as the folder itself is absent', async () => {
      await fs.symlink(outside, path.join(root, '.shared', 'sf_evil'));
      expect(await scanConfinedByWalk(root, ['.shared', 'sf_evil'])).toEqual({
        kind: 'absent',
        reason: 'link-or-not-dir',
      });
    });

    it('a file where the folder should be is absent', async () => {
      await fs.writeFile(path.join(root, '.shared', 'sf_file'), 'x');
      expect(await scanConfinedByWalk(root, ['.shared', 'sf_file'])).toMatchObject({
        kind: 'absent',
        reason: 'link-or-not-dir',
      });
    });
  });

  describe('SECURITY: special files are skipped', () => {
    const mkfifo = (p: string): boolean => spawnSync('mkfifo', [p]).status === 0;

    it('FIFOs are skipped (and never block)', async () => {
      if (!mkfifo(path.join(folder, 'pipe'))) return;
      if (!mkfifo(path.join(folder, 'memory', 'pipe2'))) return;
      const r = await scanConfinedByWalk(root, BASE);
      expect(paths(r)).toEqual(['instructions.md', 'memory/deep/x.txt', 'memory/status.md']);
    });

    it('sockets are skipped', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(path.join(folder, 'sock'), resolve));
      try {
        expect(paths(await scanConfinedByWalk(root, BASE))).toEqual([
          'instructions.md',
          'memory/deep/x.txt',
          'memory/status.md',
        ]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it.skipIf(!IS_ROOT)('devices are skipped (mknod needs root)', async () => {
      if (spawnSync('mknod', [path.join(folder, 'nul'), 'c', '1', '3']).status !== 0) return;
      expect(paths(await scanConfinedByWalk(root, BASE))).not.toContain('nul');
      expect(paths(await scanConfinedByWalk(root, BASE))).toHaveLength(3);
    });
  });

  describe('caps', () => {
    it('maxEntries caps the files and sets truncated; exactly the cap is not truncated', async () => {
      const capped = await scanConfinedByWalk(root, BASE, { maxEntries: 2 });
      expect(capped).toMatchObject({ kind: 'done', truncated: true });
      expect(paths(capped)).toHaveLength(2);
      const exact = await scanConfinedByWalk(root, BASE, { maxEntries: 3 });
      expect(exact).toMatchObject({ kind: 'done', truncated: false });
      expect(paths(exact)).toHaveLength(3);
    });

    it('stops after MAX_WALK_SKIPPED skipped entries, flagged truncated', async () => {
      const links = path.join(folder, 'links');
      await fs.mkdir(links);
      for (let i = 0; i < MAX_WALK_SKIPPED + 5; i++) {
        await fs.symlink('/etc/hostname', path.join(links, `l${i}`));
      }
      const r = await scanConfinedByWalk(root, BASE);
      expect(r).toMatchObject({ kind: 'done', truncated: true });
    });

    it('a few skipped entries do not truncate', async () => {
      await fs.symlink('/etc/hostname', path.join(folder, 'one-link'));
      expect(await scanConfinedByWalk(root, BASE)).toMatchObject({ truncated: false });
    });

    it('deep nesting: files down to MAX_WALK_PARTS components are reported, deeper ones are not', async () => {
      // root/.shared/sf_x is 2 components; nest until a file sits at exactly
      // MAX_WALK_PARTS, and one more directory below it.
      const dirsAtLimit = MAX_WALK_PARTS - BASE.length - 1;
      const atLimit = Array.from({ length: dirsAtLimit }, (_, i) => `d${i}`);
      await fs.mkdir(path.join(folder, ...atLimit, 'over'), { recursive: true });
      await fs.writeFile(path.join(folder, ...atLimit, 'ok.txt'), 'ok');
      await fs.writeFile(path.join(folder, ...atLimit, 'over', 'too-deep.txt'), 'no');
      const r = await scanConfinedByWalk(root, BASE);
      expect(r).toMatchObject({ kind: 'done', truncated: true });
      const deep = paths(r).filter((p) => p.startsWith('d0/'));
      expect(deep).toEqual([[...atLimit, 'ok.txt'].join('/')]);
      expect([...BASE, ...deep[0]!.split('/')]).toHaveLength(MAX_WALK_PARTS);
    });
  });

  describe('fds never leak', () => {
    it('on success, absence, truncation and failure', async () => {
      spawnSync('mkfifo', [path.join(folder, 'pipe')]);
      await fs.symlink(outside, path.join(folder, 'leakdir'));
      const before = openFds();
      for (let i = 0; i < 20; i++) {
        await scanConfinedByWalk(root, BASE);
        await scanConfinedByWalk(root, BASE, { maxEntries: 1 });
        await scanConfinedByWalk(root, ['.shared', 'sf_nope']);
        await scanConfinedByWalk(root, ['.shared', 'sf_x', 'instructions.md']);
        await scanConfinedByWalk(path.join(tmp, 'no-root'), BASE).catch(() => undefined);
      }
      expect(openFds()).toBe(before);
    });

    it.skipIf(IS_ROOT)('on an EACCES deep in the tree (which throws)', async () => {
      await fs.chmod(path.join(folder, 'memory'), 0o000);
      try {
        const before = openFds();
        for (let i = 0; i < 10; i++) {
          await expect(scanConfinedByWalk(root, BASE)).rejects.toBeInstanceOf(WalkReadError);
        }
        expect(openFds()).toBe(before);
      } finally {
        await fs.chmod(path.join(folder, 'memory'), 0o755);
      }
    });
  });

  describe('search-only directories (.shared is 0711 in production)', () => {
    it.skipIf(IS_ROOT)('scans THROUGH a .shared it may search but not read', async () => {
      await fs.chmod(path.join(root, '.shared'), 0o311);
      expect(paths(await scanConfinedByWalk(root, BASE))).toHaveLength(3);
    });

    it.skipIf(IS_ROOT)('EACCES opening the folder throws at depth 1', async () => {
      await fs.chmod(path.join(root, '.shared'), 0o600);
      await expect(scanConfinedByWalk(root, BASE)).rejects.toMatchObject({
        code: 'EACCES',
        depth: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // THE RACE. A child process swaps `a` between a real directory and a
  // symlink to `outside` as fast as it can while we scan. Whatever the timing,
  // a scan reports `a/inside.txt` or no `a` at all — never `a/secret.txt`.
  // -------------------------------------------------------------------------
  it(
    'SECURITY: a directory swapped for a symlink mid-scan is skipped, never followed',
    async () => {
      const a = path.join(folder, 'a');
      const real = path.join(folder, 'a.real');
      const link = path.join(folder, 'a.link');
      await fs.mkdir(real);
      await fs.writeFile(path.join(real, 'inside.txt'), 'inside');
      await fs.symlink(outside, link);

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
        const before = openFds();
        let sawInside = 0;
        let sawNone = 0;
        const deadline = Date.now() + 15_000;
        let i = 0;
        for (; i < 5_000 && Date.now() < deadline; i++) {
          const r = await scanConfinedByWalk(root, BASE);
          const ps = paths(r);
          expect(ps.some((p) => p.endsWith('secret.txt'))).toBe(false);
          if (ps.includes('a/inside.txt')) sawInside++;
          else sawNone++;
        }
        expect(i).toBeGreaterThanOrEqual(500);
        expect(sawInside).toBeGreaterThan(0);
        expect(sawNone).toBeGreaterThan(0);
        expect(openFds()).toBe(before);
      } finally {
        swapper.kill('SIGKILL');
      }
    },
    30_000,
  );
});
