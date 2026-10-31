import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_USAGE_WALK_LIMITS,
  MAX_CONCURRENT_USAGE_WALKS,
  UserFilesReadError,
  measureConfinedUserFiles,
  type UsageWalkLimits,
} from '../index.js';

// ---------------------------------------------------------------------------
// The usage walk behind the storage meter for an agent's /files (TASK-993).
//
// `measureConfinedUserFiles` sums the allocated bytes of an agent-written tree
// that sits on an export beside every other tenant's tree. Like the /files
// reader (walk-read.test.ts) it is Linux-only: it opens every folder through
// the descriptor of the folder above it, via /proc/self/fd, with O_NOFOLLOW.
// Everything that touches the disk is skipped where /proc is missing (a macOS
// laptop) and runs in CI on ubuntu-latest. A skip there is not a pass. The
// limit guard and the off-Linux refusal run everywhere.
//
// The oracle for every byte figure is computed here, from `lstat` of the root
// and of every entry the walk should count, never from the walk itself.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const SKIP_REASON = 'needs Linux /proc/self/fd (runs in CI on ubuntu-latest)';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** Big enough that counting it by mistake can't hide in a folder's blocks. */
const SECRET_SIZE = 4 * 1024 * 1024;

const allocated = (st: Stats): number =>
  Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;

/** Allocated bytes of each path, by lstat (a link is the link, not its target). */
const oracle = (...paths: Array<string | Buffer>): number =>
  paths.reduce((sum, p) => sum + allocated(lstatSync(p)), 0);

const limits = (over: Partial<UsageWalkLimits> = {}): UsageWalkLimits => ({
  ...DEFAULT_USAGE_WALK_LIMITS,
  ...over,
});

describe('measureConfinedUserFiles — guards (run everywhere)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('off Linux it throws unsupported-platform before touching the disk', async () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ax-measure-os-')));
    writeFileSync(path.join(tmp, 'x'), 'a real file the meter must not answer for');
    const open = vi.spyOn(nodeFs.promises, 'open');
    const opendir = vi.spyOn(nodeFs.promises, 'opendir');
    const d = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...d, value: 'darwin' });
    try {
      // Without /proc a walk would read every folder as gone: a reading of 0
      // for a full home. That must be an error, never a number.
      await expect(measureConfinedUserFiles(tmp)).rejects.toMatchObject({
        code: 'unsupported-platform',
      });
      await expect(measureConfinedUserFiles(tmp)).rejects.toBeInstanceOf(UserFilesReadError);
      expect(open).not.toHaveBeenCalled();
      expect(opendir).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', d);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ['maxEntries: 0', { maxEntries: 0 }],
    ['maxEntries: 1.5', { maxEntries: 1.5 }],
    ['maxDepth: -1', { maxDepth: -1 }],
    ['maxDepth: Infinity', { maxDepth: Infinity }],
    ['maxMs: NaN', { maxMs: Number.NaN }],
    ['maxMs: 0', { maxMs: 0 }],
  ])('rejects limits out of range with a RangeError (%s)', async (_label, over) => {
    // Checked before the platform, so this has teeth on macOS too: a guard
    // that ran second would answer unsupported-platform here instead.
    const open = vi.spyOn(nodeFs.promises, 'open');
    await expect(
      measureConfinedUserFiles('/nonexistent-root', limits(over as Partial<UsageWalkLimits>)),
    ).rejects.toBeInstanceOf(RangeError);
    expect(open).not.toHaveBeenCalled();
  });

  it('defaults are the documented bounds', () => {
    expect(DEFAULT_USAGE_WALK_LIMITS).toEqual({ maxEntries: 1_000_000, maxDepth: 64, maxMs: 120_000 });
    expect(Object.isFrozen(DEFAULT_USAGE_WALK_LIMITS)).toBe(true);
  });
});

describe.skipIf(!ON_LINUX)(`measureConfinedUserFiles — on disk (${SKIP_REASON})`, () => {
  let tmp: string;
  /** The export: every agent's home sits in here. */
  let exportDir: string;
  /** This agent's home: the trusted root. */
  let root: string;
  /** Another tenant's home on the same export. Never counted. */
  let outside: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ax-measure-')));
    exportDir = path.join(tmp, 'export');
    root = path.join(exportDir, 'agent-a');
    outside = path.join(exportDir, 'agent-b');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // Random bytes: a filesystem that compresses or dedups zeros can't make
    // the secret cost nothing, which would let a wrong count pass.
    writeFileSync(path.join(outside, 'secret.bin'), randomBytes(SECRET_SIZE));
    expect(allocated(lstatSync(path.join(outside, 'secret.bin')))).toBeGreaterThanOrEqual(SECRET_SIZE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // A test may have dropped permissions; restore them so cleanup can descend.
    for (const p of [root, path.join(root, 'locked')]) {
      try {
        chmodSync(p, 0o755);
      } catch {
        // gone or never made
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('AVAILABILITY: walks stuck on a hung export can never hold more than MAX_CONCURRENT_USAGE_WALKS at once', async () => {
    // A hard-mounted export that hangs: the root open never returns. The
    // callers' timeouts cannot end such a walk, so the cap has to count the
    // walk itself, or each new turn end parks another threadpool thread.
    const realOpen = nodeFs.promises.open;
    const releases: Array<() => void> = [];
    let hang = true;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (p, flags, mode) => {
      if (hang) {
        await new Promise<void>((r) => releases.push(r));
      }
      return realOpen(p, flags, mode);
    });

    const stuck = Array.from({ length: MAX_CONCURRENT_USAGE_WALKS }, () => measureConfinedUserFiles(root));
    // Let every stuck walk reach its open.
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(MAX_CONCURRENT_USAGE_WALKS);

    await expect(measureConfinedUserFiles(root)).rejects.toMatchObject({
      name: 'UserFilesReadError',
      code: 'walk-busy',
    });
    // Refused before touching the disk: no further open was attempted.
    expect(releases).toHaveLength(MAX_CONCURRENT_USAGE_WALKS);

    // The export comes back: the stuck walks finish and free their places.
    hang = false;
    for (const r of releases) r();
    for (const r of await Promise.all(stuck)) expect(r.complete).toBe(true);
    await expect(measureConfinedUserFiles(root)).resolves.toMatchObject({ complete: true });
  });

  it('sums allocated bytes of every file and folder, the root included', async () => {
    writeFileSync(path.join(root, 'a.bin'), randomBytes(10_000));
    mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
    writeFileSync(path.join(root, 'sub', 'b.bin'), randomBytes(5_000));
    writeFileSync(path.join(root, 'sub', 'deeper', 'c.bin'), randomBytes(1));
    const expected = oracle(
      root,
      path.join(root, 'a.bin'),
      path.join(root, 'sub'),
      path.join(root, 'sub', 'b.bin'),
      path.join(root, 'sub', 'deeper'),
      path.join(root, 'sub', 'deeper', 'c.bin'),
    );
    expect(await measureConfinedUserFiles(root)).toEqual({ bytes: expected, entries: 5, complete: true });
  });

  it('an empty home is its own folder, complete', async () => {
    expect(await measureConfinedUserFiles(root)).toEqual({
      bytes: oracle(root),
      entries: 0,
      complete: true,
    });
  });

  it('a home folder that does not exist yet is 0 when the export exists', async () => {
    expect(await measureConfinedUserFiles(path.join(exportDir, 'agent-never-ran'))).toEqual({
      bytes: 0,
      entries: 0,
      complete: true,
    });
  });

  it('a missing export is an error, not 0', async () => {
    const p = measureConfinedUserFiles(path.join(tmp, 'no-export', 'agent-a'));
    await expect(p).rejects.toBeInstanceOf(UserFilesReadError);
    await expect(p).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(IS_ROOT)('an unreadable home is an error, not 0', async () => {
    writeFileSync(path.join(root, 'a.bin'), randomBytes(10_000));
    chmodSync(root, 0o000);
    try {
      const p = measureConfinedUserFiles(root);
      await expect(p).rejects.toBeInstanceOf(UserFilesReadError);
      await expect(p).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it('SECURITY: a symlink to a big file outside the root counts as the link only', async () => {
    symlinkSync('../agent-b/secret.bin', path.join(root, 'link'));
    const r = await measureConfinedUserFiles(root);
    expect(r).toEqual({ bytes: oracle(root, path.join(root, 'link')), entries: 1, complete: true });
    expect(r.bytes).toBeLessThan(SECRET_SIZE);
  });

  it('SECURITY: a symlinked folder is never descended', async () => {
    symlinkSync('../agent-b', path.join(root, 'escape'));
    // An absolute link to the filesystem root, too: a walk that followed it
    // would wander the host.
    symlinkSync('/', path.join(root, 'slash'));
    const r = await measureConfinedUserFiles(root);
    expect(r).toEqual({
      bytes: oracle(root, path.join(root, 'escape'), path.join(root, 'slash')),
      entries: 2,
      complete: true,
    });
    expect(r.bytes).toBeLessThan(SECRET_SIZE);
  });

  it('SECURITY: a folder swapped for a symlink between its lstat and its open is not followed', async () => {
    const victim = path.join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(path.join(victim, 'mine.bin'), randomBytes(2_000));
    // What the walk saw before the swap: the root, and `victim` as a folder.
    // Its contents are gone by the time the walk could open it.
    const expected = oracle(root, victim);

    const realOpen = nodeFs.promises.open;
    let swapped = false;
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (p, flags, mode) => {
      if (!swapped && String(p).endsWith('/victim')) {
        swapped = true;
        // The agent's move, at the worst instant: the folder the walk just
        // lstat'd becomes a link to another tenant's home.
        rmSync(victim, { recursive: true });
        symlinkSync(outside, victim);
      }
      return realOpen(p, flags, mode);
    });

    const r = await measureConfinedUserFiles(root);
    expect(swapped).toBe(true);
    // A link where a folder was is a swap, not damage: skipped, still complete.
    expect(r).toEqual({ bytes: expected, entries: 1, complete: true });
    expect(r.bytes).toBeLessThan(SECRET_SIZE);
  });

  it('SECURITY: every folder below the root is opened through the held parent descriptor with O_NOFOLLOW', async () => {
    mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'file.bin'), randomBytes(100));
    writeFileSync(path.join(root, 'a', 'b', 'c', 'file.bin'), randomBytes(100));

    const realOpen = nodeFs.promises.open;
    const opens: Array<[string, number]> = [];
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (p, flags, mode) => {
      opens.push([String(p), Number(flags)]);
      return realOpen(p, flags, mode);
    });

    const r = await measureConfinedUserFiles(root);
    expect(r.complete).toBe(true);
    expect(r.entries).toBe(5);
    // The root by name, then exactly one open per folder (a, b, c): files are
    // never opened, and no folder is reached any other way.
    expect(opens).toHaveLength(4);
    expect(opens[0]![0]).toBe(root);
    for (const [p, flags] of opens.slice(1)) {
      expect(p).toMatch(/^\/proc\/self\/fd\/\d+\/[^/]+$/);
      expect(flags & constants.O_NOFOLLOW).not.toBe(0);
      expect(flags & constants.O_DIRECTORY).not.toBe(0);
      // Read-only, always: the meter never holds a writable handle.
      expect(flags & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
    }
  });

  it('a FIFO is counted by lstat and never opened', async () => {
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    const realOpen = nodeFs.promises.open;
    const opened: string[] = [];
    vi.spyOn(nodeFs.promises, 'open').mockImplementation(async (p, flags, mode) => {
      opened.push(String(p));
      return realOpen(p, flags, mode);
    });
    // The test's own timeout is the "no hang" proof: opening a FIFO for
    // reading waits for a writer that never comes.
    const r = await measureConfinedUserFiles(root);
    expect(r).toEqual({ bytes: oracle(root, path.join(root, 'pipe')), entries: 1, complete: true });
    expect(opened.filter((p) => p.endsWith('/pipe'))).toEqual([]);
  });

  it('a file name that is not valid UTF-8 is still counted', async () => {
    const odd = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0x6f])]);
    writeFileSync(odd, randomBytes(3000));
    // Read as text, the name would decode to "f�o", a file that does not
    // exist, and a lossy walk would quietly skip it as vanished.
    expect(allocated(lstatSync(odd))).toBeGreaterThan(0);
    const r = await measureConfinedUserFiles(root);
    expect(r).toEqual({ bytes: oracle(root, odd), entries: 1, complete: true });
  });

  it('a folder name that is not valid UTF-8 is still descended', async () => {
    const odd = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x64, 0xfe])]);
    mkdirSync(odd);
    const inner = Buffer.concat([odd, Buffer.from('/inner.bin')]);
    writeFileSync(inner, randomBytes(3000));
    const r = await measureConfinedUserFiles(root);
    expect(r).toEqual({ bytes: oracle(root, odd, inner), entries: 2, complete: true });
  });

  it.skipIf(IS_ROOT)('a folder it may not read is skipped and the reading is partial', async () => {
    const locked = path.join(root, 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'hidden.bin'), randomBytes(50_000));
    chmodSync(locked, 0o000);
    try {
      const r = await measureConfinedUserFiles(root);
      // `locked` itself is counted (its lstat is in the readable root); what
      // is inside it can't be, so the reading is a lower bound.
      expect(r).toEqual({ bytes: oracle(root, locked), entries: 1, complete: false });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('stops at maxEntries and says the reading is partial', async () => {
    for (let i = 0; i < 5; i++) writeFileSync(path.join(root, `f${i}.bin`), randomBytes(100));
    const r = await measureConfinedUserFiles(root, limits({ maxEntries: 3 }));
    expect(r.entries).toBe(3);
    expect(r.complete).toBe(false);
  });

  it('a tree of exactly maxEntries is complete', async () => {
    for (let i = 0; i < 3; i++) writeFileSync(path.join(root, `f${i}.bin`), randomBytes(100));
    const r = await measureConfinedUserFiles(root, limits({ maxEntries: 3 }));
    expect(r).toEqual({
      bytes: oracle(root, ...[0, 1, 2].map((i) => path.join(root, `f${i}.bin`))),
      entries: 3,
      complete: true,
    });
  });

  it('does not descend past maxDepth, and says so', async () => {
    const d1 = path.join(root, 'd1');
    const d2 = path.join(d1, 'd2');
    const d3 = path.join(d2, 'd3');
    mkdirSync(d3, { recursive: true });
    writeFileSync(path.join(d3, 'deep.bin'), randomBytes(50_000));
    const r = await measureConfinedUserFiles(root, limits({ maxDepth: 2 }));
    // d3 is an entry of a depth-2 folder, so it is counted; opening it would
    // be depth 3, so deep.bin is not.
    expect(r).toEqual({ bytes: oracle(root, d1, d2, d3), entries: 3, complete: false });
  });

  it('maxDepth 0 counts the root and its entries without opening any folder', async () => {
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'x.bin'), randomBytes(50_000));
    const r = await measureConfinedUserFiles(root, limits({ maxDepth: 0 }));
    expect(r).toEqual({ bytes: oracle(root, path.join(root, 'sub')), entries: 1, complete: false });
  });

  it('stops when maxMs runs out, and says so', async () => {
    for (let i = 0; i < 300; i++) writeFileSync(path.join(root, `f${i}`), '');
    let now = 0;
    const clock = (): number => (now += 1_000);
    const r = await measureConfinedUserFiles(root, limits({ maxMs: 1 }), clock);
    expect(r.complete).toBe(false);
    expect(r.entries).toBeLessThan(300);
    // The same tree with a clock that never moves is read whole: the stop
    // above was the clock, not something else.
    const still = await measureConfinedUserFiles(root, limits({ maxMs: 1 }), () => 0);
    expect(still).toMatchObject({ entries: 300, complete: true });
  });

  it('closes every descriptor it opened', async () => {
    const fds = (): number => readdirSync('/proc/self/fd').length;
    mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    for (const d of ['a', 'a/b', 'a/b/c']) {
      for (let i = 0; i < 4; i++) writeFileSync(path.join(root, d, `f${i}`), randomBytes(10));
    }
    // Warm up first, so a descriptor the runtime opens once on first use
    // (and keeps) is not mistaken for one the walk leaked.
    await measureConfinedUserFiles(root);
    const before = fds();
    const full = await measureConfinedUserFiles(root);
    expect(full.complete).toBe(true);
    expect(fds()).toBe(before);
    // Stopped mid-walk, with folders below the root still open when it stops.
    const capped = await measureConfinedUserFiles(root, limits({ maxEntries: 5 }));
    expect(capped.complete).toBe(false);
    expect(fds()).toBe(before);
  });
});
