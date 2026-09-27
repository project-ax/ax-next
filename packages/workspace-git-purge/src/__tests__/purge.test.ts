import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { purgeHistoryPaths, type RunGit } from '../purge.js';
import { bareClone, makeSandbox, Scratch, type Sandbox } from './helpers.js';

const PREFIXES = ['memory/', 'permanent/memory/facts/'];
const KEEP = ['memory/system/rules.md'];

const CAFE = 'memory/docs/general/café "x".md';
const NEWLINE = 'memory/docs/general/new\nline.md';
const SPACE = 'memory/docs/a b/space doc.md';

const EXPECTED_PURGED = [
  CAFE,
  NEWLINE,
  SPACE,
  'memory/docs/dup.md',
  'memory/docs/general/a.md',
  'memory/docs/side.md',
  'memory/inbox/i1.md',
  'memory/system/recent.md',
  'memory/system/user.md',
  'permanent/memory/facts/profile.md',
].sort();

const TRICKY_MESSAGE =
  'Tricky message\n\n' +
  `M 100644 ${'0123456789abcdef'.repeat(2)}01234567 memory/docs/x.md\n` +
  'D memory/x\n' +
  'commit refs/heads/evil\n' +
  'data 5\n' +
  'reset refs/heads/main\n';

interface Fixture {
  gitdir: string;
  scratch: Scratch;
  trickySha: string;
  /** blob ids that must be gone after the purge */
  purgedBlobs: string[];
  /** blob id of content shared by a purged path and a kept path */
  sharedBlob: string;
}

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

async function blobOf(s: Scratch, path: string): Promise<string> {
  return (await s.g(['rev-parse', `HEAD:${path}`])).toString().trim();
}

async function buildFixture(): Promise<Fixture> {
  const s = await Scratch.init(sb);
  const purgedBlobs: string[] = [];

  s.write('memory/system/rules.md', 'rules v1\n');
  s.write('memory/system/user.md', 'user profile SECRET-USER\n');
  s.write('memory/docs/general/a.md', 'doc A v1 SECRET-A1\n');
  s.write('permanent/memory/facts/profile.md', 'facts v1 SECRET-F1\n');
  s.write('.ax/IDENTITY.md', 'I am the agent\n');
  s.write('notes/a.md', 'note a v1\n');
  s.write('memory-notes.md', 'sibling file, not memory\n');
  s.write('memorybank/x.md', 'sibling dir, not memory\n');
  await s.commit('c1: initial');
  purgedBlobs.push(
    await blobOf(s, 'memory/system/user.md'),
    await blobOf(s, 'memory/docs/general/a.md'),
    await blobOf(s, 'permanent/memory/facts/profile.md'),
  );

  s.write('memory/inbox/i1.md', 'inbox SECRET-INBOX\n');
  s.write('notes/a.md', 'note a v2\n');
  s.write('memory/system/recent.md', 'recent SECRET-RECENT\n');
  s.write(CAFE, 'cafe SECRET-CAFE\n');
  s.write(NEWLINE, 'newline SECRET-NL\n');
  s.write(SPACE, 'space SECRET-SPACE\n');
  s.write('notes/ü "q".md', 'quoted non-memory\n');
  await s.commit('c2: more docs\n\nwith a body');
  for (const p of ['memory/inbox/i1.md', 'memory/system/recent.md', CAFE, NEWLINE, SPACE]) {
    purgedBlobs.push(await blobOf(s, p));
  }

  s.write('memory/system/rules.md', 'rules v2\n');
  s.write('memory/docs/general/a.md', 'doc A v2 SECRET-A2\n');
  s.write('permanent/memory/facts/profile.md', 'facts v2 SECRET-F2\n');
  await s.commit('c3: rules v2 + doc edits');
  purgedBlobs.push(
    await blobOf(s, 'memory/docs/general/a.md'),
    await blobOf(s, 'permanent/memory/facts/profile.md'),
  );

  // A side branch merged back (exercises `merge` in the stream and -m diffs).
  await s.g(['checkout', '-q', '-b', 'side']);
  s.write('memory/docs/side.md', 'side doc SECRET-SIDE\n');
  s.write('notes/side.md', 'side note\n');
  await s.commit('side: doc + note');
  purgedBlobs.push(await blobOf(s, 'memory/docs/side.md'));
  await s.g(['checkout', '-q', 'main']);
  s.write('notes/main.md', 'main note\n');
  await s.commit('c4: main note');
  await s.g(['-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  await s.g(['branch', '-q', '-D', 'side']);

  s.write('notes/b.md', 'note b\n');
  const trickySha = await s.commit(TRICKY_MESSAGE);

  s.write('memory/docs/dup.md', 'shared content\n');
  s.write('notes/dup.md', 'shared content\n');
  s.remove('memory/inbox/i1.md');
  s.write('memory/system/rules.md', 'rules v3\n');
  await s.commit('c6: dup + delete inbox + rules v3');
  const sharedBlob = await blobOf(s, 'notes/dup.md');

  // A commit that touches ONLY purged paths: it must survive, emptied.
  s.write('memory/docs/general/a.md', 'doc A v3 SECRET-A3\n');
  await s.commit('c7: memory only');
  purgedBlobs.push(await blobOf(s, 'memory/docs/general/a.md'));

  const gitdir = await bareClone(sb, s.dir);
  return { gitdir, scratch: s, trickySha, purgedBlobs, sharedBlob };
}

function isPurgedPath(p: string): boolean {
  return PREFIXES.some((pre) => p.startsWith(pre)) && !KEEP.includes(p);
}

async function mainSha(gitdir: string): Promise<string> {
  return (await sb.git(['--git-dir=' + gitdir, 'rev-parse', 'refs/heads/main'])).toString().trim();
}

async function refs(gitdir: string): Promise<string[]> {
  const out = (await sb.git(['--git-dir=' + gitdir, 'for-each-ref', '--format=%(refname)']))
    .toString()
    .split('\n')
    .filter(Boolean);
  return out.sort();
}

async function historyPaths(gitdir: string): Promise<string[]> {
  const out = await sb.git([
    '--git-dir=' + gitdir,
    'log',
    '--all',
    '--format=',
    '--name-only',
    '--no-renames',
    '--root',
    '-m',
    '-z',
  ]);
  return [
    ...new Set(
      out
        .toString('utf8')
        .split('\0')
        .map((s) => s.replace(/^\n+/, ''))
        .filter(Boolean),
    ),
  ];
}

/** Independent formulation (full patches, no --raw) of the per-commit history. */
async function patchLog(gitdir: string, pathspec: readonly string[]): Promise<string> {
  return (
    await sb.git([
      '--git-dir=' + gitdir,
      'log',
      '--no-color',
      '--format=%x02%an|%ae|%ad|%cn|%ce|%cd|%x03%B',
      '--date=raw',
      '-p',
      '--full-history',
      '-m',
      '--root',
      '--no-renames',
      'refs/heads/main',
      '--',
      ...pathspec,
    ])
  ).toString('utf8');
}

async function allCommitMeta(gitdir: string): Promise<string> {
  return (
    await sb.git([
      '--git-dir=' + gitdir,
      'log',
      '--topo-order',
      '--format=%x02%an|%ae|%ad|%cn|%ce|%cd|%x03%B',
      '--date=raw',
      'refs/heads/main',
    ])
  ).toString('utf8');
}

async function objectNames(gitdir: string): Promise<string[]> {
  // `rev-list --objects` prints "<oid> <path>"; a path containing LF spills onto
  // the next line, whose text still starts with the matching prefix fragment.
  return (await sb.git(['--git-dir=' + gitdir, 'rev-list', '--all', '--objects']))
    .toString('utf8')
    .split('\n')
    .map((l) => (/^[0-9a-f]{40} /.test(l) ? l.slice(41) : l))
    .filter(Boolean);
}

async function unreachableObjects(gitdir: string): Promise<string[]> {
  const reach = new Set(
    (await sb.git(['--git-dir=' + gitdir, 'rev-list', '--all', '--objects', '--no-object-names']))
      .toString()
      .split('\n')
      .filter(Boolean),
  );
  const all = (
    await sb.git([
      '--git-dir=' + gitdir,
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname)',
    ])
  )
    .toString()
    .split('\n')
    .filter(Boolean);
  return all.filter((o) => !reach.has(o));
}

async function hasObject(gitdir: string, oid: string): Promise<boolean> {
  const r = await sb.runGit(['--git-dir=' + gitdir, 'cat-file', '-e', oid]);
  return r.code === 0;
}

const NON_MEMORY = ['.', ...PREFIXES.map((p) => `:(exclude,literal)${p}`)];
const KEEP_SPEC = KEEP.map((k) => `:(literal)${k}`);

describe('purgeHistoryPaths', () => {
  it('erases every matching path from the tip, all history and the object store; nothing else changes', async () => {
    const fx = await buildFixture();
    const { gitdir } = fx;
    const beforeMain = await mainSha(gitdir);
    const beforeCount = (await sb.git(['--git-dir=' + gitdir, 'rev-list', '--count', 'main'])).toString();
    const beforeNonMemory = await patchLog(gitdir, NON_MEMORY);
    const beforeRules = await patchLog(gitdir, KEEP_SPEC);
    const beforeMeta = await allCommitMeta(gitdir);
    const beforeTrickyMsg = (
      await sb.git(['--git-dir=' + gitdir, 'cat-file', 'commit', fx.trickySha])
    ).toString('utf8');
    // sanity: the fixture really has the stuff we claim to purge
    expect((await historyPaths(gitdir)).filter(isPurgedPath).sort()).toEqual(EXPECTED_PURGED);
    for (const b of fx.purgedBlobs) expect(await hasObject(gitdir, b)).toBe(true);

    const res = await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit });

    expect(res.purged).toEqual(EXPECTED_PURGED);
    expect(res.pastVersionsChanged).toBe(true);
    expect(res.recovered).toBe(false);
    const afterMain = await mainSha(gitdir);
    expect(res.version).toBe(afterMain);
    expect(afterMain).not.toBe(beforeMain);
    expect(await refs(gitdir)).toEqual(['refs/heads/main']);

    // tip tree
    const tip = (await sb.git(['--git-dir=' + gitdir, 'ls-tree', '-r', '-z', '--name-only', 'main']))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(tip.filter(isPurgedPath)).toEqual([]);
    expect(tip).toEqual(
      [
        '.ax/IDENTITY.md',
        'memory-notes.md',
        'memory/system/rules.md',
        'memorybank/x.md',
        'notes/a.md',
        'notes/b.md',
        'notes/dup.md',
        'notes/main.md',
        'notes/side.md',
        'notes/ü "q".md',
      ].sort(),
    );
    expect(
      (await sb.git(['--git-dir=' + gitdir, 'show', 'main:memory/system/rules.md'])).toString(),
    ).toBe('rules v3\n');

    // all history + every reachable object path
    expect((await historyPaths(gitdir)).filter(isPurgedPath)).toEqual([]);
    const names = await objectNames(gitdir);
    const allowedDirs = new Set(['memory', 'memory/system']);
    expect(
      names.filter(
        (n) =>
          (n.startsWith('memory/') || n.startsWith('permanent/') || n.startsWith('line.md')) &&
          !KEEP.includes(n) &&
          !allowedDirs.has(n),
      ),
    ).toEqual([]);

    // blob content gone from the store, except content shared with a kept path
    for (const b of fx.purgedBlobs) expect(await hasObject(gitdir, b)).toBe(false);
    expect(await hasObject(gitdir, fx.sharedBlob)).toBe(true);
    expect(await unreachableObjects(gitdir)).toEqual([]);

    // everything else byte-identical
    expect((await sb.git(['--git-dir=' + gitdir, 'rev-list', '--count', 'main'])).toString()).toBe(
      beforeCount,
    );
    expect(await patchLog(gitdir, NON_MEMORY)).toBe(beforeNonMemory);
    expect(await patchLog(gitdir, KEEP_SPEC)).toBe(beforeRules);
    expect(await allCommitMeta(gitdir)).toBe(beforeMeta);
    expect(beforeMeta).toContain(TRICKY_MESSAGE);

    // the tricky commit keeps its exact message; only tree/parent lines differ
    const newTricky = (
      await sb.git([
        '--git-dir=' + gitdir,
        'log',
        '--format=%H',
        '--grep=^Tricky message$',
        'main',
      ])
    )
      .toString()
      .trim();
    expect(newTricky).toMatch(/^[0-9a-f]{40}$/);
    const stripIds = (s: string): string =>
      s.replace(/^(tree|parent) [0-9a-f]+\n/gm, '');
    expect(
      stripIds(
        (await sb.git(['--git-dir=' + gitdir, 'cat-file', 'commit', newTricky])).toString('utf8'),
      ),
    ).toBe(stripIds(beforeTrickyMsg));
  });

  it('is a no-op on a second run', async () => {
    const { gitdir } = await buildFixture();
    await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit });
    const first = await mainSha(gitdir);
    const seen: string[] = [];
    const spy: RunGit = (args, opts) => {
      seen.push(args.join(' '));
      return sb.runGit(args, opts);
    };
    const res = await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: spy });
    expect(res).toEqual({ purged: [], version: first, pastVersionsChanged: false, recovered: false });
    expect(await mainSha(gitdir)).toBe(first);
    expect(seen.some((a) => a.includes('fast-import') || a.includes(' gc'))).toBe(false);
  });

  it('returns version null for a repo with no main and creates nothing', async () => {
    const gitdir = join(sb.root, 'empty.git');
    await sb.git(['init', '-q', '--bare', '-b', 'main', gitdir]);
    const res = await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit });
    expect(res).toEqual({ purged: [], version: null, pastVersionsChanged: false, recovered: false });
    expect(await refs(gitdir)).toEqual([]);
    const objs = (
      await sb.git([
        '--git-dir=' + gitdir,
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname)',
      ])
    ).toString();
    expect(objs).toBe('');
  });

  it('refuses a repo holding any ref other than main, leaving it untouched', async () => {
    const { gitdir } = await buildFixture();
    const before = await mainSha(gitdir);
    await sb.git(['--git-dir=' + gitdir, 'update-ref', 'refs/heads/other', before]);
    await expect(
      purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit }),
    ).rejects.toThrow(/unexpected ref/);
    expect(await mainSha(gitdir)).toBe(before);
    expect((await historyPaths(gitdir)).filter(isPurgedPath).length).toBeGreaterThan(0);
  });

  it('refuses a detached HEAD', async () => {
    const { gitdir } = await buildFixture();
    const before = await mainSha(gitdir);
    await sb.git(['--git-dir=' + gitdir, 'update-ref', '--no-deref', 'HEAD', before]);
    await expect(
      purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit }),
    ).rejects.toThrow(/HEAD/);
    expect(await mainSha(gitdir)).toBe(before);
  });

  it('rejects an invalid selector before touching the repo', async () => {
    const { gitdir } = await buildFixture();
    let calls = 0;
    const spy: RunGit = (a, o) => {
      calls += 1;
      return sb.runGit(a, o);
    };
    await expect(
      purgeHistoryPaths({ gitdir, prefixes: ['memory'], keep: [], runGit: spy }),
    ).rejects.toThrow();
    await expect(
      purgeHistoryPaths({ gitdir, prefixes: ['memory/'], keep: ['notes/a.md'], runGit: spy }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  describe('failure injection', () => {
    function failing(pred: (args: readonly string[]) => boolean): RunGit {
      return async (args, opts) => {
        if (pred(args)) return { code: 1, stdout: Buffer.alloc(0), stderr: 'injected failure' };
        return sb.runGit(args, opts);
      };
    }
    const isMainCas = (a: readonly string[]): boolean =>
      a.includes('update-ref') && a.includes('refs/heads/main') && !a.includes('-d');

    async function assertFullyPurgedAfterCleanRun(gitdir: string): Promise<void> {
      const res = await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit });
      expect((await historyPaths(gitdir)).filter(isPurgedPath)).toEqual([]);
      expect(await unreachableObjects(gitdir)).toEqual([]);
      expect(await refs(gitdir)).toEqual(['refs/heads/main']);
      expect(res.version).toBe(await mainSha(gitdir));
    }

    it('update-ref of main fails → main unchanged, temp ref cleared, next run completes', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      await expect(
        purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: failing(isMainCas) }),
      ).rejects.toThrow(/update-ref/);
      expect(await mainSha(gitdir)).toBe(before);
      expect(await refs(gitdir)).toEqual(['refs/heads/main']);
      expect((await historyPaths(gitdir)).filter(isPurgedPath).sort()).toEqual(EXPECTED_PURGED);
      await assertFullyPurgedAfterCleanRun(gitdir);
    });

    it('temp-ref cleanup also fails → leftover ref is recovered by the next run', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      await expect(
        purgeHistoryPaths({
          gitdir,
          prefixes: PREFIXES,
          keep: KEEP,
          runGit: failing((a) => isMainCas(a) || (a.includes('update-ref') && a.includes('-d'))),
        }),
      ).rejects.toThrow(/update-ref/);
      expect(await mainSha(gitdir)).toBe(before);
      expect(await refs(gitdir)).toEqual(['refs/ax-purge/main', 'refs/heads/main']);
      const res = await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit });
      expect(res.recovered).toBe(true);
      expect(res.purged).toEqual(EXPECTED_PURGED);
      expect((await historyPaths(gitdir)).filter(isPurgedPath)).toEqual([]);
      expect(await unreachableObjects(gitdir)).toEqual([]);
      expect(await refs(gitdir)).toEqual(['refs/heads/main']);
    });

    it('gc fails after main moved → throws; next run recovers and leaves no unreachable objects', async () => {
      const fx = await buildFixture();
      const { gitdir } = fx;
      const before = await mainSha(gitdir);
      await expect(
        purgeHistoryPaths({
          gitdir,
          prefixes: PREFIXES,
          keep: KEEP,
          runGit: failing((a) => a.includes('gc')),
        }),
      ).rejects.toThrow(/gc/);
      const moved = await mainSha(gitdir);
      expect(moved).not.toBe(before);
      // the old history is still in the object store at this point
      expect(await hasObject(gitdir, fx.purgedBlobs[0]!)).toBe(true);
      expect(await refs(gitdir)).toContain('refs/ax-purge/main');

      const res = await purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: sb.runGit });
      expect(res).toEqual({ purged: [], version: moved, pastVersionsChanged: false, recovered: true });
      expect(await unreachableObjects(gitdir)).toEqual([]);
      for (const b of fx.purgedBlobs) expect(await hasObject(gitdir, b)).toBe(false);
      expect(await refs(gitdir)).toEqual(['refs/heads/main']);
    });

    it('fast-import fails → main unchanged; next run completes', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      await expect(
        purgeHistoryPaths({
          gitdir,
          prefixes: PREFIXES,
          keep: KEEP,
          runGit: failing((a) => a.includes('fast-import')),
        }),
      ).rejects.toThrow(/fast-import/);
      expect(await mainSha(gitdir)).toBe(before);
      await assertFullyPurgedAfterCleanRun(gitdir);
    });

    // Drops notes/a.md's FIRST version (c1). c2 rewrites the file, so the tip
    // tree still matches: only the per-commit history comparison can see it.
    it('a corrupted rewrite (an intermediate non-memory change dropped) fails verification; main untouched', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      let dropped = false;
      const corrupting: RunGit = (args, opts) => {
        if (args.includes('fast-import') && opts?.input) {
          const lines = opts.input.toString('latin1').split('\n');
          const idx = lines.findIndex((l) => /^M \d+ [0-9a-f]+ notes\/a\.md$/.test(l));
          if (idx >= 0) {
            lines.splice(idx, 1);
            dropped = true;
          }
          return sb.runGit(args, { input: Buffer.from(lines.join('\n'), 'latin1') });
        }
        return sb.runGit(args, opts);
      };
      await expect(
        purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: corrupting }),
      ).rejects.toThrow(/verif/);
      expect(dropped).toBe(true);
      expect(await mainSha(gitdir)).toBe(before);
      expect(await refs(gitdir)).toEqual(['refs/heads/main']);
    });

    it('a corrupted rewrite (kept path change dropped) fails verification', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      let dropped = false;
      const corrupting: RunGit = (args, opts) => {
        if (args.includes('fast-import') && opts?.input) {
          const lines = opts.input.toString('latin1').split('\n');
          const idx = lines.findIndex((l) => l.endsWith(' memory/system/rules.md') && l.startsWith('M '));
          if (idx >= 0) {
            lines.splice(idx, 1);
            dropped = true;
          }
          return sb.runGit(args, { input: Buffer.from(lines.join('\n'), 'latin1') });
        }
        return sb.runGit(args, opts);
      };
      await expect(
        purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: corrupting }),
      ).rejects.toThrow(/verif/);
      expect(dropped).toBe(true);
      expect(await mainSha(gitdir)).toBe(before);
    });

    it('a corrupted rewrite (commit message altered) fails verification', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      const corrupting: RunGit = (args, opts) => {
        if (args.includes('fast-import') && opts?.input) {
          // same length so the data block stays well-formed
          const s = opts.input.toString('latin1').replace('c4: main note', 'c4: main NOTE');
          return sb.runGit(args, { input: Buffer.from(s, 'latin1') });
        }
        return sb.runGit(args, opts);
      };
      await expect(
        purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: corrupting }),
      ).rejects.toThrow(/verif/);
      expect(await mainSha(gitdir)).toBe(before);
    });

    it('a corrupted rewrite (a purged path left in) fails verification', async () => {
      const { gitdir } = await buildFixture();
      const before = await mainSha(gitdir);
      const corrupting: RunGit = (args, opts) => {
        if (args.includes('fast-import') && opts?.input) {
          const text = opts.input.toString('latin1');
          const blob = /^M 100644 ([0-9a-f]{40}) notes\/a\.md$/m.exec(text)![1]!;
          const s = text
            .replace('\ndone\n', `\n`)
            .concat(
              `commit refs/ax-purge/main\ncommitter X <x@y> 1 +0000\ndata 1\nx\nM 100644 ${blob} memory/leak.md\n\ndone\n`,
            );
          return sb.runGit(args, { input: Buffer.from(s, 'latin1') });
        }
        return sb.runGit(args, opts);
      };
      await expect(
        purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: corrupting }),
      ).rejects.toThrow(/verif/);
      expect(await mainSha(gitdir)).toBe(before);
    });

    it('a commit racing onto main before the swap → throws; main keeps the racing commit', async () => {
      const fx = await buildFixture();
      const { gitdir } = fx;
      let raced = '';
      const racing: RunGit = async (args, opts) => {
        if (isMainCas(args) && !raced) {
          fx.scratch.write('notes/race.md', 'raced in\n');
          raced = await fx.scratch.commit('racing commit');
          await fx.scratch.g(['push', '-q', gitdir, 'main:main']);
        }
        return sb.runGit(args, opts);
      };
      await expect(
        purgeHistoryPaths({ gitdir, prefixes: PREFIXES, keep: KEEP, runGit: racing }),
      ).rejects.toThrow(/update-ref/);
      expect(raced).toMatch(/^[0-9a-f]{40}$/);
      expect(await mainSha(gitdir)).toBe(raced);
      expect(await refs(gitdir)).toEqual(['refs/heads/main']);
    });
  });
});
