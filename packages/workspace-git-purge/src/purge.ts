// ---------------------------------------------------------------------------
// purgeHistoryPaths — irrecoverably erase a path selector from EVERY version of
// one bare repository: the tip, all of history, and the object store.
//
// This is the git realization of `workspace:purge` (see @ax/core workspace.ts).
// It rewrites history, so it is written to fail closed: every git exit code is
// checked, every recognised stream command is whitelisted, and the rewritten
// history is verified against the original BEFORE the branch moves.
//
// CRASH-SAFETY CONTRACT
//   * `refs/heads/main` only ever moves by ONE compare-and-swap `update-ref`
//     (new tip, expected old tip), issued only after verification passed.
//   * The rewrite is staged at `refs/ax-purge/main`. A crash BEFORE the swap
//     leaves main untouched plus that leftover temp ref; the next run notices
//     it (`recovered: true`), discards it and purges from scratch.
//   * A crash AFTER the swap but before the temp ref is deleted (i.e. during
//     reflog expiry / gc / final verification) is detected by the same leftover
//     ref; the next run finds nothing left to rewrite, and re-runs reflog
//     expiry + gc + final verification before deleting the ref. The temp ref is
//     therefore deleted only as the very last step, after final verification —
//     it doubles as the "compaction not yet proven" marker.
//
// CALLER CONTRACT
//   * The caller serializes access to the repository (no concurrent pushes,
//     applies or gc) for the duration of the call. The CAS swap still refuses
//     to clobber a racing update, but gc under a concurrent writer is unsafe.
//   * The caller clears its own transient refs first: any ref other than
//     `refs/heads/main` (and our own `refs/ax-purge/*`) makes this THROW —
//     an unknown ref would keep the old history reachable.
//   * `runGit` spawns `git` with an argv array (never a shell) and the
//     caller's own sanitized environment. This module never spawns anything.
//
// Error messages name the step that failed and never include git's stderr or
// any path: the paths under the selector are the data being erased.
// ---------------------------------------------------------------------------

import { validatePurgeSelector } from '@ax/core';
import {
  filterFastExportStreamDetailed,
  makePathMatcher,
  SOURCE_REF,
  TEMP_REF,
  type PathMatcher,
} from './stream.js';

export interface GitRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}
export type RunGit = (
  args: readonly string[],
  opts?: { input?: Buffer },
) => Promise<GitRunResult>;

export interface PurgeHistoryOptions {
  /** Absolute path of the bare repository. */
  gitdir: string;
  prefixes: readonly string[];
  keep?: readonly string[];
  runGit: RunGit;
}

export interface PurgeHistoryResult {
  /** Sorted distinct paths erased from any version. */
  purged: string[];
  /** Tip of main after the purge; null when the repository has no main. */
  version: string | null;
  /** True when history was rewritten (old version ids no longer resolve). */
  pastVersionsChanged: boolean;
  /** True when a previous interrupted run's leftovers were found and finished. */
  recovered: boolean;
}

const TEMP_NS = 'refs/ax-purge/';
const OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

class PurgeError extends Error {
  constructor(message: string) {
    super(`workspace purge: ${message}`);
    this.name = 'PurgeError';
  }
}

export async function purgeHistoryPaths(opts: PurgeHistoryOptions): Promise<PurgeHistoryResult> {
  const prefixes = [...opts.prefixes];
  const keep = [...(opts.keep ?? [])];
  // Step 1 — selector (throws PluginError 'invalid-input').
  validatePurgeSelector({ prefixes, keep });
  const { gitdir, runGit } = opts;
  if (typeof gitdir !== 'string' || !gitdir.startsWith('/') || gitdir.includes('\0')) {
    throw new PurgeError('gitdir must be an absolute path');
  }
  const matcher = makePathMatcher(prefixes, keep);

  // Every invocation is pinned to this repository, runs no repository hooks,
  // and cannot be switched into literal-pathspec mode by the environment (which
  // would make the `:(literal)` magic below match nothing — a silent no-op).
  const base = ['--no-literal-pathspecs', '-c', 'core.hooksPath=/dev/null', `--git-dir=${gitdir}`];
  const raw = (args: readonly string[], input?: Buffer): Promise<GitRunResult> =>
    runGit([...base, ...args], input === undefined ? undefined : { input });
  const git = async (step: string, args: readonly string[], input?: Buffer): Promise<Buffer> => {
    const r = await raw(args, input);
    if (r.code !== 0) throw new PurgeError(`${step} failed (git exit ${String(r.code)})`);
    return r.stdout;
  };
  const revParse = async (step: string, ref: string): Promise<string> => {
    const out = (await git(step, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))
      .toString('latin1')
      .trim();
    if (!OID_RE.test(out)) throw new PurgeError(`${step}: unexpected object id`);
    return out;
  };
  const deleteRef = (step: string, ref: string): Promise<Buffer> =>
    git(step, ['update-ref', '-d', ref]);

  const pathspecSelect = [
    ...prefixes.map((p) => `:(literal)${p}`),
    ...keep.map((k) => `:(exclude,literal)${k}`),
  ];

  /** Paths under the selector touched by any commit reachable from `revs`. */
  const detect = async (step: string, revs: readonly string[]): Promise<Map<string, string>> => {
    const out = await git(step, [
      'log',
      ...revs,
      '--format=',
      '--name-only',
      '--no-renames',
      '--root',
      '-m',
      '-z',
      '--',
      ...pathspecSelect,
    ]);
    const found = new Map<string, string>();
    let start = 0;
    while (start < out.length) {
      let end = out.indexOf(0, start);
      if (end < 0) end = out.length;
      const tok = out.subarray(start, end);
      start = end + 1;
      if (tok.length === 0) continue;
      // Some git versions separate commits with a newline even under -z. Test
      // both the token and the token without leading LFs, so a separator can
      // never hide a match from verification.
      let s = 0;
      while (s < tok.length && tok[s] === 0x0a) s += 1;
      for (const cand of s > 0 ? [tok.subarray(s), tok] : [tok]) {
        if (matcher(cand)) {
          found.set(cand.toString('latin1'), cand.toString('utf8'));
          break;
        }
      }
    }
    return found;
  };

  const listRefs = async (step: string): Promise<Map<string, string>> => {
    const out = (await git(step, ['for-each-ref', '--format=%(refname) %(objectname)']))
      .toString('latin1')
      .split('\n')
      .filter(Boolean);
    const m = new Map<string, string>();
    for (const line of out) {
      const sp = line.lastIndexOf(' ');
      m.set(line.slice(0, sp), line.slice(sp + 1));
    }
    return m;
  };

  const exportMain = (step: string, ref: string): Promise<Buffer> =>
    git(step, [
      'fast-export',
      '--no-data',
      '--use-done-feature',
      '--reencode=no',
      '--signed-tags=strip',
      '--tag-of-filtered-object=drop',
      ref,
    ]);

  // Step 2 — leftovers of an interrupted run.
  const refsBefore = await listRefs('list refs');
  const tempRefs = [...refsBefore.keys()].filter((r) => r.startsWith(TEMP_NS));
  const recovered = tempRefs.length > 0;

  // Step 3 — refuse unknown refs; they would keep old history reachable.
  const unknown = [...refsBefore.keys()].filter((r) => r !== SOURCE_REF && !r.startsWith(TEMP_NS));
  if (unknown.length > 0) {
    throw new PurgeError(`refusing to rewrite: unexpected ref(s) present: ${unknown.slice(0, 5).join(', ')}`);
  }
  const head = await raw(['symbolic-ref', '-q', 'HEAD']);
  if (head.code !== 0) throw new PurgeError('refusing to rewrite: HEAD is detached');

  if (!refsBefore.has(SOURCE_REF)) {
    if (recovered) throw new PurgeError('leftover purge ref present but main is missing');
    return { purged: [], version: null, pastVersionsChanged: false, recovered };
  }

  // Step 4.
  const oldTip = await revParse('resolve main', SOURCE_REF);

  const compactAndVerify = async (expectedTip: string): Promise<void> => {
    // Step 9 — drop every other route to the old objects, then the objects.
    await git('reflog expire', [
      'reflog',
      'expire',
      '--expire=now',
      '--expire-unreachable=now',
      '--all',
    ]);
    await git('gc', ['gc', '--prune=now', '--quiet']);
    // Step 10 — final verification.
    if ((await revParse('final verification', SOURCE_REF)) !== expectedTip) {
      throw new PurgeError('final verification failed: main moved during compaction');
    }
    if ((await detect('final verification', ['--all'])).size > 0) {
      throw new PurgeError('final verification failed: purged paths still reachable');
    }
    const reachable = new Set(
      (await git('final verification', ['rev-list', '--all', '--objects', '--no-object-names']))
        .toString('latin1')
        .split('\n')
        .filter(Boolean),
    );
    const stored = (
      await git('final verification', [
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname)',
      ])
    )
      .toString('latin1')
      .split('\n')
      .filter(Boolean);
    if (stored.length !== reachable.size || stored.some((o) => !reachable.has(o))) {
      throw new PurgeError('final verification failed: unreachable objects survived');
    }
    // Last: the marker goes only once compaction is proven.
    for (const r of (await listRefs('final verification')).keys()) {
      if (r.startsWith(TEMP_NS)) await deleteRef('delete temp ref', r);
    }
  };

  // Step 5 — detect.
  const detected = await detect('detect', ['--all']);
  // Independent cross-check with our own byte parser over main's history:
  // `git log` pathspecs and the stream filter must agree on what matches.
  const exported = await exportMain('export', SOURCE_REF);
  const filtered = filterFastExportStreamDetailed(exported, matcher);
  const streamPaths = new Set(filtered.dropped.keys());
  if (
    streamPaths.size !== detected.size ||
    [...streamPaths].some((p) => !detected.has(p))
  ) {
    throw new PurgeError('detection disagreement between history scan and export stream');
  }

  if (detected.size === 0) {
    if (!recovered) {
      return { purged: [], version: oldTip, pastVersionsChanged: false, recovered };
    }
    // Finishing an interrupted run: a temp ref that is not main is a stale
    // pre-swap rewrite and must not keep its objects alive through gc.
    for (const [r, oid] of await listRefs('recover')) {
      if (r.startsWith(TEMP_NS) && oid !== oldTip) await deleteRef('recover', r);
    }
    await compactAndVerify(oldTip);
    return { purged: [], version: oldTip, pastVersionsChanged: false, recovered };
  }

  // Step 6 — rewrite into the temp ref.
  for (const r of tempRefs) await deleteRef('clear temp ref', r);
  let newTip: string;
  try {
    await git('fast-import', ['fast-import', '--quiet'], filtered.stream);
    newTip = await revParse('resolve rewrite', TEMP_REF);
    // Step 7 — verify before moving main.
    await verifyRewrite({ git, detect, exportMain, matcher, oldTip, newTip, prefixes, keep });
    // Step 8 — the one and only move of main.
    await git('update-ref main', ['update-ref', SOURCE_REF, newTip, oldTip]);
  } catch (err) {
    // Main has not moved; discard the staged rewrite. If this cleanup fails
    // too, the leftover ref is recovered by the next run.
    await raw(['update-ref', '-d', TEMP_REF]).catch(() => undefined);
    throw err;
  }

  // Steps 9 + 10.
  await compactAndVerify(newTip);

  const purged = [...new Set(detected.values())].sort();
  return { purged, version: newTip, pastVersionsChanged: true, recovered };
}

interface VerifyDeps {
  git: (step: string, args: readonly string[], input?: Buffer) => Promise<Buffer>;
  detect: (step: string, revs: readonly string[]) => Promise<Map<string, string>>;
  exportMain: (step: string, ref: string) => Promise<Buffer>;
  matcher: PathMatcher;
  oldTip: string;
  newTip: string;
  prefixes: readonly string[];
  keep: readonly string[];
}

// Per-commit metadata (author, committer, raw dates, encoding, full message) +
// raw diffs of the given pathspec, for EVERY commit. `--full-history --sparse`
// keeps commits whose diff under the pathspec is empty (proven by the
// "memory-only commit" fixture), so a dropped or reordered commit shows up
// even when it touched nothing outside the purge selector.
const LOG_META = [
  'log',
  '--no-color',
  '--no-abbrev',
  '--no-ext-diff',
  '--no-textconv',
  '--no-show-signature',
  '--topo-order',
  '--full-history',
  '--sparse',
  '--no-renames',
  '-m',
  '--root',
  '--raw',
  '--date=raw',
  '--format=%x01%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%e%x00%B',
];

async function verifyRewrite(d: VerifyDeps): Promise<void> {
  const fail = (what: string): never => {
    throw new PurgeError(`verification failed: ${what}`);
  };
  const { git, oldTip, newTip } = d;

  // a. nothing under the selector anywhere in the new history — by git's
  //    pathspec scan AND by our own stream parser.
  if ((await d.detect('verification', [newTip])).size > 0) fail('purged paths remain');
  const reexport = await d.exportMain('verification', TEMP_REF);
  const again = filterFastExportStreamDetailed(reexport, d.matcher, {
    sourceRef: TEMP_REF,
    targetRef: TEMP_REF,
  });
  if (again.dropped.size > 0) fail('purged paths remain in export');

  // b. identical commit graph shape (count + parent structure by position).
  const shape = async (tip: string): Promise<string> => {
    const lines = (await git('verification', ['rev-list', '--topo-order', '--parents', tip]))
      .toString('latin1')
      .split('\n')
      .filter(Boolean);
    const index = new Map<string, number>();
    lines.forEach((l, i) => index.set(l.split(' ')[0]!, i));
    return lines
      .map((l) =>
        l
          .split(' ')
          .map((oid) => {
            const i = index.get(oid);
            if (i === undefined) fail('parent outside history');
            return String(i);
          })
          .join(' '),
      )
      .join('\n');
  };
  const [oldShape, newShape] = [await shape(oldTip), await shape(newTip)];
  if (oldShape.split('\n').length !== newShape.split('\n').length) fail('commit count differs');
  if (oldShape !== newShape) fail('commit graph differs');

  // c. per-commit metadata + everything outside the selector, byte-identical.
  const outside = ['.', ...d.prefixes.map((p) => `:(exclude,literal)${p}`)];
  const logOf = (tip: string, spec: readonly string[]): Promise<Buffer> =>
    git('verification', [...LOG_META, tip, '--', ...spec]);
  if (!(await logOf(oldTip, outside)).equals(await logOf(newTip, outside))) {
    fail('history outside the purged paths differs');
  }
  if (d.keep.length > 0) {
    const kept = d.keep.map((k) => `:(literal)${k}`);
    if (!(await logOf(oldTip, kept)).equals(await logOf(newTip, kept))) {
      fail('history of kept paths differs');
    }
  }

  // d. tip trees: old minus the selector equals new, entry for entry.
  const tree = async (tip: string): Promise<Buffer[]> => {
    const out = await git('verification', ['ls-tree', '-r', '-z', '--full-tree', tip]);
    const entries: Buffer[] = [];
    let s = 0;
    while (s < out.length) {
      let e = out.indexOf(0, s);
      if (e < 0) e = out.length;
      if (e > s) entries.push(out.subarray(s, e));
      s = e + 1;
    }
    return entries;
  };
  const pathOf = (entry: Buffer): Buffer => entry.subarray(entry.indexOf(0x09) + 1);
  const oldTree = (await tree(oldTip)).filter((e) => !d.matcher(pathOf(e)));
  const newTree = await tree(newTip);
  if (newTree.some((e) => d.matcher(pathOf(e)))) fail('purged paths remain at tip');
  if (
    oldTree.length !== newTree.length ||
    oldTree.some((e, i) => !e.equals(newTree[i]!))
  ) {
    fail('tip tree differs');
  }
}
