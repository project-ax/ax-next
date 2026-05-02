// ---------------------------------------------------------------------------
// prepareScratchRepo — host-side bundler entry point (Phase 3).
//
// Builds a one-shot tempdir with:
//   1. A bare scratch repo.
//   2. The workspace's baseline state (loaded from a self-contained
//      bundle the workspace plugin produced via
//      `workspace:export-baseline-bundle`). The baseline OID matches
//      the runner's local `refs/heads/baseline` by construction.
//   3. The runner's thin bundle fetched into the scratch repo. Now
//      `HEAD` is the runner's tip; `baselineCommit..HEAD` is the
//      per-turn diff.
//
// Returns `{ repoPath, baselineCommit, dispose }`. The verifier and
// walker operate on `repoPath` with `baselineCommit` as the range
// anchor. The handler must call `dispose` to clean up.
//
// Why baseline-from-bundle (not deterministic reconstruction): for the
// FIRST apply (parent=null), we could rebuild a deterministic baseline
// from workspace:list+read. But for SUBSEQUENT applies, the runner's
// baseline OID is the actual previous-turn commit (real timestamps,
// not deterministic), and reconstruction would produce a different
// OID, failing the thin bundle's prereq check. The export-baseline-
// bundle hook delegates to the workspace plugin's mirror cache, which
// has the actual OID for both cases. One code path, both turns.
//
// Lifecycle: handler-scoped. Created at commit-notify start, disposed
// at handler return (success OR failure). No cross-call state. If a
// handler crash leaks the tempdir, `os.tmpdir()` cleanup hits it
// eventually; not a load-bearing leak.
// ---------------------------------------------------------------------------

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk, runGit } from './git-spawn.js';

export interface PrepareScratchRepoInput {
  /** Base64-encoded thin bundle from the runner. Must be non-empty. */
  bundleBytes: string;
  /**
   * Base64-encoded baseline bundle from the workspace plugin (via
   * `workspace:export-baseline-bundle`). Self-contained — contains
   * all commits reachable from the workspace's state at parent, with
   * one ref `refs/heads/main` pointing at it.
   */
  baselineBundleBytes: string;
}

export interface PreparedScratchRepo {
  /** Working-tree path; pass to runGit({cwd}) for read-only ops. */
  repoPath: string;
  /** Baseline commit OID (the bundle's prereq match point). */
  baselineCommit: string;
  /** Cleanup. Idempotent — safe to call multiple times or in finally. */
  dispose: () => Promise<void>;
}

/**
 * Build a scratch bare-repo seeded with the workspace's baseline
 * (from the export-baseline-bundle), then load the runner's thin
 * bundle on top.
 *
 * After this returns:
 *   - `<repoPath>/refs/heads/main` -> baseline commit OID (from the
 *      baseline bundle).
 *   - `<repoPath>/refs/bundle/main` (or similar) -> runner's tip
 *     (from the thin bundle).
 *   - HEAD points at the bundle's tip so `baselineCommit..HEAD` is
 *     the per-turn diff.
 *   - `git rev-list baselineCommit..HEAD` walks the runner's per-turn
 *     commits.
 *   - `git diff-tree -r baselineCommit..HEAD` produces the diff.
 */
export async function prepareScratchRepo(
  input: PrepareScratchRepoInput,
): Promise<PreparedScratchRepo> {
  if (input.bundleBytes === '') {
    throw new Error(
      'prepareScratchRepo: empty bundleBytes (handler should short-circuit empty turns before calling)',
    );
  }
  if (input.baselineBundleBytes === '') {
    throw new Error(
      'prepareScratchRepo: empty baselineBundleBytes (workspace plugin must always ship a baseline)',
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), 'ax-scratch-'));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(tmp, { recursive: true, force: true });
  };

  try {
    const repoPath = join(tmp, 'work.git');
    await mkdir(repoPath, { recursive: true });

    // -------------------------------------------------------------
    // 1. Init a BARE scratch repo. We don't need a working tree;
    //    verify + walk operate on git plumbing (rev-list, diff-tree,
    //    cat-file, ls-tree) which doesn't need a checkout.
    // -------------------------------------------------------------
    await expectOk(
      await runGit(['init', '--bare', '-b', 'main', repoPath]),
      'git init --bare',
    );

    // -------------------------------------------------------------
    // 2. Load the workspace's baseline bundle. It ships
    //    refs/heads/main -> baseline OID. Fetch onto refs/heads/main.
    // -------------------------------------------------------------
    const baselineBundlePath = join(tmp, 'baseline.bundle');
    await writeFile(
      baselineBundlePath,
      Buffer.from(input.baselineBundleBytes, 'base64'),
    );
    await expectOk(
      await runGit(
        [
          '-C',
          repoPath,
          'fetch',
          '--quiet',
          baselineBundlePath,
          'refs/heads/main:refs/heads/main',
        ],
      ),
      'git fetch baseline bundle',
    );

    // Capture the baseline OID. This is what the runner's thin bundle
    // declares as its prereq.
    const baselineRevParse = await runGit(
      ['-C', repoPath, 'rev-parse', 'refs/heads/main'],
    );
    await expectOk(baselineRevParse, 'git rev-parse refs/heads/main');
    const baselineCommit = baselineRevParse.stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(baselineCommit)) {
      throw new Error(
        `prepareScratchRepo: invalid baseline OID ${JSON.stringify(baselineCommit)}`,
      );
    }

    // -------------------------------------------------------------
    // 3. Load the runner's thin bundle. Prereq is satisfied by the
    //    baseline we just loaded. Route into refs/bundle/* so it
    //    doesn't clobber refs/heads/main.
    // -------------------------------------------------------------
    const thinBundlePath = join(tmp, 'thin.bundle');
    await writeFile(thinBundlePath, Buffer.from(input.bundleBytes, 'base64'));
    await expectOk(
      await runGit(
        [
          '-C',
          repoPath,
          'fetch',
          '--quiet',
          thinBundlePath,
          'refs/heads/*:refs/bundle/*',
        ],
      ),
      'git fetch thin bundle',
    );

    // Pick the bundle's tip. The runner ships exactly one ref under
    // refs/heads/* (main, by convention from `git checkout -b main`
    // in materializeWorkspace). After the fetch above it lands at
    // refs/bundle/main.
    const bundleRefs = await runGit(
      ['-C', repoPath, 'for-each-ref', '--format=%(refname)', 'refs/bundle/'],
    );
    await expectOk(bundleRefs, 'git for-each-ref refs/bundle');
    const refList = bundleRefs.stdout
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (refList.length === 0) {
      throw new Error(
        'prepareScratchRepo: bundle introduced no refs (malformed bundle?)',
      );
    }
    if (refList.length > 1) {
      throw new Error(
        `prepareScratchRepo: bundle introduced ${refList.length} refs (expected exactly 1): ${refList.join(', ')}`,
      );
    }
    // Point HEAD at the bundle's tip so verify/walk can name it as `HEAD`.
    await expectOk(
      await runGit(
        ['-C', repoPath, 'symbolic-ref', 'HEAD', refList[0]!],
      ),
      'git symbolic-ref HEAD',
    );

    return { repoPath, baselineCommit, dispose };
  } catch (err) {
    // On construction failure, dispose immediately — the caller never
    // sees a leaked tempdir.
    await dispose();
    throw err;
  }
}
