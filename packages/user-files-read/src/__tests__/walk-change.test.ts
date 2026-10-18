import { createHash } from 'node:crypto';
import { existsSync, fstatSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CHANGE_COUNT,
  MAX_CHANGE_FILE_BYTES,
  MAX_CHANGE_TOTAL_BYTES,
  WalkChangeError,
  changeConfinedByWalk,
  type ChangeConfinedOptions,
  type ConfinedChange,
} from '../walk-change.js';
import { WalkPathError, WalkReadError } from '../walk-read.js';

// ---------------------------------------------------------------------------
// The confined writer (W3c, Task 1). Same Linux-only mechanism as the reader,
// so the on-disk half is skipped where /proc is missing and runs in CI
// (ubuntu-latest). Validation runs everywhere: it happens before the disk.
//
// Every SECURITY case is something an agent that writes the shared folder can
// plant: a symlink at the folder itself, at an intermediate directory, or at
// the leaf a person is about to save over.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const SKIP_REASON = 'needs Linux /proc/<pid>/fd (runs in CI on ubuntu-latest)';

const OPTS: ChangeConfinedOptions = { maxFileBytes: 1024, maxTotalBytes: 2048, maxChanges: 8 };
const BASE = ['.shared', 'sf_x'];
const SECRET = 'SECRET-do-not-touch';

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const write = (p: string, s: string, extra: Partial<ConfinedChange> = {}): ConfinedChange =>
  ({ op: 'write', path: p, content: bytes(s), ...extra }) as ConfinedChange;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('changeConfinedByWalk — validation (before the disk)', () => {
  // A root that does not exist: anything that got past validation would throw
  // a storage error instead, so these prove the order.
  const run = (changes: ConfinedChange[], opts = OPTS, base = BASE) =>
    changeConfinedByWalk('/nonexistent-root', base, changes, opts);

  it.each([['..'], ['a/../b'], ['/abs'], ['a//b'], ['a/'], ['a\0b']])(
    'SECURITY: refuses the path %j',
    (p) => {
      expect(caught(() => run([write(p, 'x')]))).toBeInstanceOf(WalkPathError);
    },
  );

  it('a write and a delete need a non-empty path', () => {
    expect(caught(() => run([write('', 'x')]))).toBeInstanceOf(WalkPathError);
    expect(caught(() => run([{ op: 'delete', path: '' }]))).toBeInstanceOf(WalkPathError);
  });

  it.each([[['..', 'sf_x']], [['.shared', '']], [['a/b']], [['.']]])(
    'SECURITY: refuses the base %j',
    (base) => {
      expect(caught(() => run([write('a', 'x')], OPTS, base))).toBeInstanceOf(WalkPathError);
    },
  );

  it('validates EVERY change before applying any (a bad last path refuses the call)', () => {
    expect(caught(() => run([write('ok', 'x'), { op: 'delete', path: '../x' }]))).toBeInstanceOf(
      WalkPathError,
    );
  });

  it('refuses a file over maxFileBytes', () => {
    const err = caught(() => run([write('a', 'x'.repeat(OPTS.maxFileBytes + 1))]));
    expect(err).toBeInstanceOf(WalkChangeError);
    expect((err as WalkChangeError).code).toBe('too-large');
    expect((err as WalkChangeError).index).toBe(0);
  });

  it('refuses a call whose content totals over maxTotalBytes', () => {
    const kib = 'x'.repeat(1024);
    const err = caught(() => run([write('a', kib), write('b', kib), write('c', '!')]));
    expect((err as WalkChangeError).code).toBe('too-large');
    expect((err as WalkChangeError).index).toBe(2);
  });

  it('refuses more than maxChanges changes', () => {
    const many = Array.from({ length: OPTS.maxChanges + 1 }, (_, i) => write(`f${i}`, 'x'));
    expect((caught(() => run(many)) as WalkChangeError).code).toBe('too-many-changes');
  });

  it.each([
    [{ ...OPTS, maxChanges: MAX_CHANGE_COUNT + 1 }],
    [{ ...OPTS, maxFileBytes: MAX_CHANGE_FILE_BYTES + 1 }],
    [{ ...OPTS, maxTotalBytes: MAX_CHANGE_TOTAL_BYTES + 1 }],
    [{ ...OPTS, maxChanges: 0 }],
  ])('refuses out-of-range limits %j', (opts) => {
    expect(caught(() => run([], opts))).toBeInstanceOf(RangeError);
  });

  it('pins the ceilings: 64 changes, 10 MiB a file, 25 MiB a call', () => {
    expect(MAX_CHANGE_COUNT).toBe(64);
    expect(MAX_CHANGE_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_CHANGE_TOTAL_BYTES).toBe(25 * 1024 * 1024);
  });

  it('refuses a malformed ifMatch, and ifMatch together with ifAbsent', () => {
    const bad = caught(() => run([write('a', 'x', { ifMatch: 'NOT-A-HASH' })]));
    expect((bad as WalkChangeError).code).toBe('invalid-change');
    const both = caught(() => run([write('a', 'x', { ifMatch: sha('x'), ifAbsent: true })]));
    expect((both as WalkChangeError).code).toBe('invalid-change');
  });

  it('refuses an unknown op', () => {
    const err = caught(() => run([{ op: 'chmod', path: 'a' } as unknown as ConfinedChange]));
    expect((err as WalkChangeError).code).toBe('invalid-change');
  });
});

describe.skipIf(!ON_LINUX)(`changeConfinedByWalk — on disk (${SKIP_REASON})`, () => {
  let tmp: string;
  /** The trusted root (the export mount). */
  let root: string;
  /** The shared folder inside it. */
  let folder: string;
  /** Somewhere a write must never reach. */
  let outside: string;

  const change = (changes: ConfinedChange[], opts: Partial<ChangeConfinedOptions> = {}) =>
    changeConfinedByWalk(root, BASE, changes, { ...OPTS, ...opts });
  const read = (rel: string) => fs.readFile(path.join(folder, rel), 'utf8');
  /** Every entry under the folder, so a leftover `.ax-tmp-*` shows up. */
  const tree = async (): Promise<string[]> =>
    (await fs.readdir(folder, { recursive: true })).map(String).sort();

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-walk-change-')));
    root = path.join(tmp, 'export');
    folder = path.join(root, '.shared', 'sf_x');
    outside = path.join(tmp, 'outside');
    await fs.mkdir(path.join(folder, 'memory'), { recursive: true });
    await fs.writeFile(path.join(folder, 'instructions.md'), 'be kind');
    await fs.writeFile(path.join(folder, 'memory', 'status.md'), 'all good');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), SECRET);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('write', () => {
    it('creates a new file (0644) and its missing parent directories (0755)', async () => {
      const r = change([write('work/notes/a.md', 'hello')]);
      expect(r).toEqual([{ path: 'work/notes/a.md', outcome: 'created' }]);
      expect(await read('work/notes/a.md')).toBe('hello');
      expect((await fs.stat(path.join(folder, 'work/notes/a.md'))).mode & 0o777).toBe(0o644);
      expect((await fs.stat(path.join(folder, 'work'))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(folder, 'work/notes'))).mode & 0o777).toBe(0o755);
    });

    it('replaces an existing file: written', async () => {
      expect(change([write('instructions.md', 'be brave')])).toEqual([
        { path: 'instructions.md', outcome: 'written' },
      ]);
      expect(await read('instructions.md')).toBe('be brave');
      expect(await tree()).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.ax-tmp-/)]));
    });

    it('ifMatch with the current hash writes', async () => {
      expect(change([write('instructions.md', 'v2', { ifMatch: sha('be kind') })])).toEqual([
        { path: 'instructions.md', outcome: 'written' },
      ]);
      expect(await read('instructions.md')).toBe('v2');
    });

    it('ifMatch with a stale hash is a conflict and writes nothing', async () => {
      expect(change([write('instructions.md', 'v2', { ifMatch: sha('stale') })])).toEqual([
        { path: 'instructions.md', outcome: 'conflict' },
      ]);
      expect(await read('instructions.md')).toBe('be kind');
      expect((await tree()).some((n) => n.includes('.ax-tmp-'))).toBe(false);
    });

    it('ifMatch against a missing file is a conflict', async () => {
      expect(change([write('gone.md', 'v2', { ifMatch: sha('x') })])).toEqual([
        { path: 'gone.md', outcome: 'conflict' },
      ]);
      expect(existsSync(path.join(folder, 'gone.md'))).toBe(false);
    });

    it('ifAbsent creates a missing file', async () => {
      expect(change([write('new.md', 'fresh', { ifAbsent: true })])).toEqual([
        { path: 'new.md', outcome: 'created' },
      ]);
      expect(await read('new.md')).toBe('fresh');
      expect((await tree()).some((n) => n.includes('.ax-tmp-'))).toBe(false);
    });

    it('ifAbsent never overwrites: exists, bytes untouched, no temp left', async () => {
      expect(change([write('instructions.md', 'clobber', { ifAbsent: true })])).toEqual([
        { path: 'instructions.md', outcome: 'exists' },
      ]);
      expect(await read('instructions.md')).toBe('be kind');
      expect((await tree()).some((n) => n.includes('.ax-tmp-'))).toBe(false);
    });

    it('SECURITY: ifAbsent treats a dangling symlink as taken and does not write through it', async () => {
      await fs.symlink(path.join(outside, 'planted.txt'), path.join(folder, 'link.md'));
      expect(change([write('link.md', 'x', { ifAbsent: true })])).toEqual([
        { path: 'link.md', outcome: 'exists' },
      ]);
      expect(existsSync(path.join(outside, 'planted.txt'))).toBe(false);
    });

    it('a directory in the way of a write is refused, and no temp is left', async () => {
      const err = caught(() => change([write('memory', 'x')]));
      expect(err).toBeInstanceOf(WalkChangeError);
      expect((err as WalkChangeError).code).toBe('is-directory');
      expect((await fs.stat(path.join(folder, 'memory'))).isDirectory()).toBe(true);
      expect((await tree()).some((n) => n.includes('.ax-tmp-'))).toBe(false);
    });

    it('a file used as a directory is refused', async () => {
      const err = caught(() => change([write('instructions.md/x', 'x')]));
      expect((err as WalkChangeError).code).toBe('link-or-not-dir');
      expect(await read('instructions.md')).toBe('be kind');
    });

    it.skipIf(process.getuid?.() === 0)('a storage error is WalkReadError (EACCES), and leaves nothing behind', async () => {
      // Root ignores the mode bits, so this one needs a non-root runner.
      await fs.chmod(path.join(folder, 'memory'), 0o555);
      try {
        const err = caught(() => change([write('memory/status.md', 'x')]));
        expect(err).toBeInstanceOf(WalkReadError);
        expect((err as WalkReadError).code).toBe('EACCES');
      } finally {
        await fs.chmod(path.join(folder, 'memory'), 0o755);
      }
      expect((await fs.readdir(path.join(folder, 'memory'))).sort()).toEqual(['status.md']);
    });
  });

  describe('mkdir', () => {
    it('creates missing directories (mkdir -p), then reports exists', async () => {
      expect(change([{ op: 'mkdir', path: 'playbooks/deep/er' }])).toEqual([
        { path: 'playbooks/deep/er', outcome: 'created' },
      ]);
      expect((await fs.stat(path.join(folder, 'playbooks/deep/er'))).isDirectory()).toBe(true);
      expect(change([{ op: 'mkdir', path: 'playbooks/deep/er', ifAbsent: true }])).toEqual([
        { path: 'playbooks/deep/er', outcome: 'exists' },
      ]);
    });

    it('a file where a directory goes is refused', () => {
      const err = caught(() => change([{ op: 'mkdir', path: 'instructions.md' }]));
      expect((err as WalkChangeError).code).toBe('link-or-not-dir');
    });
  });

  describe('delete', () => {
    it('deletes a file', async () => {
      expect(change([{ op: 'delete', path: 'memory/status.md' }])).toEqual([
        { path: 'memory/status.md', outcome: 'deleted' },
      ]);
      expect(existsSync(path.join(folder, 'memory/status.md'))).toBe(false);
    });

    it('deletes an empty directory', async () => {
      await fs.mkdir(path.join(folder, 'empty'));
      expect(change([{ op: 'delete', path: 'empty' }])).toEqual([
        { path: 'empty', outcome: 'deleted' },
      ]);
      expect(existsSync(path.join(folder, 'empty'))).toBe(false);
    });

    it('a missing name, or a missing parent, is absent', () => {
      expect(change([{ op: 'delete', path: 'nope.md' }])).toEqual([
        { path: 'nope.md', outcome: 'absent' },
      ]);
      expect(change([{ op: 'delete', path: 'no/such/dir.md' }])).toEqual([
        { path: 'no/such/dir.md', outcome: 'absent' },
      ]);
    });

    it('a non-empty directory is refused and kept', async () => {
      const err = caught(() => change([{ op: 'delete', path: 'memory' }]));
      expect(err).toBeInstanceOf(WalkChangeError);
      expect((err as WalkChangeError).code).toBe('not-empty');
      expect(await read('memory/status.md')).toBe('all good');
    });

    it('SECURITY: a symlink leaf is removed as a link; its target survives', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'link.md'));
      expect(change([{ op: 'delete', path: 'link.md' }])).toEqual([
        { path: 'link.md', outcome: 'deleted' },
      ]);
      expect(existsSync(path.join(folder, 'link.md'))).toBe(false);
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
    });

    it('SECURITY: a symlinked directory leaf is unlinked, not emptied', async () => {
      await fs.symlink(outside, path.join(folder, 'dirlink'));
      expect(change([{ op: 'delete', path: 'dirlink' }])).toEqual([
        { path: 'dirlink', outcome: 'deleted' },
      ]);
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
    });
  });

  describe('SECURITY: a planted symlink is refused and never followed', () => {
    it('at the base (the folder itself is a link)', async () => {
      await fs.rm(folder, { recursive: true });
      await fs.symlink(outside, folder);
      for (const createBase of [false, true]) {
        const err = caught(() => change([write('secret.txt', 'pwned')], { createBase }));
        expect(err).toBeInstanceOf(WalkChangeError);
        expect((err as WalkChangeError).code).toBe('link-or-not-dir');
      }
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
    });

    it('at an intermediate base component (.shared is a link)', async () => {
      const shared = path.join(root, '.shared');
      await fs.rename(shared, path.join(tmp, 'real-shared'));
      await fs.symlink(path.join(tmp, 'real-shared'), shared);
      const err = caught(() => change([write('instructions.md', 'pwned')]));
      expect((err as WalkChangeError).code).toBe('link-or-not-dir');
      expect(await fs.readFile(path.join(tmp, 'real-shared/sf_x/instructions.md'), 'utf8')).toBe(
        'be kind',
      );
    });

    it('at an intermediate directory under the base, for every op', async () => {
      await fs.symlink(outside, path.join(folder, 'work'));
      for (const c of [
        write('work/secret.txt', 'pwned'),
        { op: 'mkdir', path: 'work/sub' } as ConfinedChange,
        { op: 'delete', path: 'work/secret.txt' } as ConfinedChange,
      ]) {
        const err = caught(() => change([c]));
        expect((err as WalkChangeError).code).toBe('link-or-not-dir');
      }
      expect(await fs.readdir(outside)).toEqual(['secret.txt']);
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
    });

    it('at the leaf: a write replaces the link itself, never the file it points to', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'notes.md'));
      expect(change([write('notes.md', 'mine')])).toEqual([{ path: 'notes.md', outcome: 'written' }]);
      expect((await fs.lstat(path.join(folder, 'notes.md'))).isFile()).toBe(true);
      expect(await read('notes.md')).toBe('mine');
      expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
    });

    it('at the leaf: ifMatch does not hash through a link (conflict, even with the target hash)', async () => {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'notes.md'));
      expect(change([write('notes.md', 'mine', { ifMatch: sha(SECRET) })])).toEqual([
        { path: 'notes.md', outcome: 'conflict' },
      ]);
      expect((await fs.lstat(path.join(folder, 'notes.md'))).isSymbolicLink()).toBe(true);
    });
  });

  describe('ordering', () => {
    it('applies changes in order', async () => {
      const r = change([
        { op: 'mkdir', path: 'work' },
        write('work/a.md', 'one'),
        write('work/a.md', 'two'),
        { op: 'delete', path: 'instructions.md' },
      ]);
      expect(r.map((x) => x.outcome)).toEqual(['created', 'created', 'written', 'deleted']);
      expect(await read('work/a.md')).toBe('two');
    });

    it('stops at the first conflict, returning results up to and including it', async () => {
      const r = change([
        write('a.md', 'a'),
        write('instructions.md', 'x', { ifMatch: sha('stale') }),
        write('b.md', 'b'),
      ]);
      expect(r).toEqual([
        { path: 'a.md', outcome: 'created' },
        { path: 'instructions.md', outcome: 'conflict' },
      ]);
      expect(existsSync(path.join(folder, 'b.md'))).toBe(false);
    });

    it('a refusal mid-batch reports what was already applied', async () => {
      const err = caught(() =>
        change([write('a.md', 'a'), { op: 'delete', path: 'memory' }, write('b.md', 'b')]),
      ) as WalkChangeError;
      expect(err.code).toBe('not-empty');
      expect(err.index).toBe(1);
      expect(err.applied).toEqual([{ path: 'a.md', outcome: 'created' }]);
      expect(existsSync(path.join(folder, 'b.md'))).toBe(false);
    });
  });

  describe('chown and createBase', () => {
    it('chown is called once for each created file and directory, with that object', async () => {
      const inodes: number[] = [];
      change(
        [write('work/n/a.md', 'a'), { op: 'mkdir', path: 'playbooks' }, write('instructions.md', 'x')],
        { chown: (fd) => inodes.push(fstatSync(fd).ino) },
      );
      const ino = async (rel: string) => (await fs.stat(path.join(folder, rel))).ino;
      // work, work/n, the a.md temp (now a.md), playbooks, the instructions.md temp.
      expect(inodes).toEqual([
        await ino('work'),
        await ino('work/n'),
        await ino('work/n/a.md'),
        await ino('playbooks'),
        await ino('instructions.md'),
      ]);
    });

    it('chown is not called for directories that already exist', () => {
      const calls: number[] = [];
      change([{ op: 'mkdir', path: 'memory' }], { chown: (fd) => calls.push(fd) });
      expect(calls).toEqual([]);
    });

    it('createBase makes a missing folder (0700, chowned) and writes into it', async () => {
      const calls: number[] = [];
      const r = changeConfinedByWalk(root, ['.shared', 'sf_new'], [write('instructions.md', 'hi')], {
        ...OPTS,
        createBase: true,
        chown: (fd) => calls.push(fstatSync(fd).ino),
      });
      expect(r).toEqual([{ path: 'instructions.md', outcome: 'created' }]);
      const made = path.join(root, '.shared', 'sf_new');
      expect((await fs.stat(made)).mode & 0o777).toBe(0o700);
      expect(calls[0]).toBe((await fs.stat(made)).ino);
      expect(await fs.readFile(path.join(made, 'instructions.md'), 'utf8')).toBe('hi');
    });

    it('createBase on an existing folder just uses it (no chown)', () => {
      const calls: number[] = [];
      change([{ op: 'mkdir', path: 'memory' }], { createBase: true, chown: (fd) => calls.push(fd) });
      expect(calls).toEqual([]);
    });

    it('createBase creates only the LAST base component', () => {
      const err = caught(() =>
        changeConfinedByWalk(root, ['.nope', 'sf_new'], [], { ...OPTS, createBase: true }),
      );
      expect(err).toBeInstanceOf(WalkReadError);
      expect((err as WalkReadError).code).toBe('ENOENT');
      expect(existsSync(path.join(root, '.nope'))).toBe(false);
    });

    it('without createBase a missing folder is ENOENT, and nothing is created', () => {
      const err = caught(() => changeConfinedByWalk(root, ['.shared', 'sf_new'], [], OPTS));
      expect((err as WalkReadError).code).toBe('ENOENT');
      expect(existsSync(path.join(root, '.shared', 'sf_new'))).toBe(false);
    });
  });

  describe('search-only base directories (.shared is 0711 in production)', () => {
    it.skipIf(process.getuid?.() === 0)('writes THROUGH a .shared it may search but not read', async () => {
      await fs.chmod(path.join(root, '.shared'), 0o311);
      try {
        expect(change([write('instructions.md', 'v2')])).toEqual([
          { path: 'instructions.md', outcome: 'written' },
        ]);
      } finally {
        await fs.chmod(path.join(root, '.shared'), 0o755);
      }
      expect(await read('instructions.md')).toBe('v2');
    });
  });
});
