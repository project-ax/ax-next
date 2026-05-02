// ---------------------------------------------------------------------------
// prepareScratchRepo — host-side bundler entry point (Phase 3).
//
// Builds a one-shot tempdir with:
//   1. A bare scratch repo.
//   2. A reconstructed `baseline` commit, deterministically built from
//      the workspace's current state (sorted paths, fixed dates, fixed
//      author env). The OID matches the runner's local
//      `refs/heads/baseline`.
//   3. The runner's thin bundle fetched into the scratch repo. Now
//      `HEAD` is the runner's tip; `baseline..HEAD` is the per-turn
//      diff.
//
// Returns `{ repoPath, baselineCommit, dispose }`. The verifier and
// walker operate on `repoPath` with `baselineCommit` as the range
// anchor. The handler must call `dispose` to clean up.
//
// Why deterministic baseline (load-bearing): the runner's thin bundle
// declares `baseline-OID` as a prerequisite. The host has to PROVIDE
// that OID by reconstructing the same commit. If the construction
// drifts (different timestamps, different file ordering, different
// author env), the OIDs diverge and `git fetch <bundle>` rejects with
// "fatal: bad object". See `buildBaselineBundle` (in
// workspace-materialize.ts) for the deterministic construction details.
//
// Lifecycle: handler-scoped. Created at commit-notify start, disposed
// at handler return (success OR failure). No cross-call state. If a
// handler crash leaks the tempdir, `os.tmpdir()` cleanup hits it
// eventually; not a load-bearing leak.
// ---------------------------------------------------------------------------

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk, runGit, runGitDeterministic } from './git-spawn.js';

export interface PrepareScratchRepoInput {
  /** Base64-encoded thin bundle from the runner. Must be non-empty. */
  bundleBytes: string;
  /**
   * Snapshot of the workspace at `parent` version (the runner's
   * baseline state). Sorted internally; caller doesn't need to sort.
   */
  baselineFiles: ReadonlyArray<{ path: string; bytes: Buffer }>;
}

export interface PreparedScratchRepo {
  /** Working-tree path; pass to runGit({cwd}) for read-only ops. */
  repoPath: string;
  /** Reconstructed baseline commit OID. Use as the range anchor. */
  baselineCommit: string;
  /** Cleanup. Idempotent — safe to call multiple times or in finally. */
  dispose: () => Promise<void>;
}

/**
 * Build a scratch working-tree repo seeded with a deterministic
 * baseline commit, then load the runner's thin bundle into it.
 *
 * After this returns:
 *   - `<repoPath>/.git/refs/heads/baseline` → reconstructed baseline OID
 *   - `<repoPath>/.git/refs/heads/<runner-branch>` → bundle's tip
 *   - `git rev-list baseline..HEAD` walks the runner's per-turn commits
 *   - `git diff-tree -r baseline..HEAD` produces the per-turn diff
 */
export async function prepareScratchRepo(
  input: PrepareScratchRepoInput,
): Promise<PreparedScratchRepo> {
  if (input.bundleBytes === '') {
    throw new Error(
      'prepareScratchRepo: empty bundleBytes (handler should short-circuit empty turns before calling)',
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
    const repoPath = join(tmp, 'work');
    await mkdir(repoPath, { recursive: true });

    // -------------------------------------------------------------
    // 1. Init the repo + reconstruct baseline (deterministically).
    //
    // Same shape as buildBaselineBundle in workspace-materialize.ts —
    // we duplicate the logic here rather than calling into that
    // function because (a) we need the working-tree result, not a
    // bundle, and (b) buildBaselineBundle's tempdir lifecycle is
    // distinct from ours. The deterministic guarantees come from
    // runGitDeterministic + sorted paths + 0o644 mode +
    // core.fileMode=false.
    // -------------------------------------------------------------
    await expectOk(
      await runGitDeterministic(['init', '-b', 'baseline', repoPath]),
      'git init',
    );
    await expectOk(
      await runGitDeterministic(['config', 'core.fileMode', 'false'], {
        cwd: repoPath,
      }),
      'git config core.fileMode',
    );
    const sorted = [...input.baselineFiles].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    for (const { path, bytes } of sorted) {
      const abs = join(repoPath, path);
      const dir = abs.slice(0, abs.lastIndexOf('/'));
      if (dir.length > 0 && dir !== repoPath) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(abs, bytes, { mode: 0o644 });
    }
    await expectOk(
      await runGitDeterministic(['add', '-A'], { cwd: repoPath }),
      'git add',
    );
    await expectOk(
      await runGitDeterministic(
        ['commit', '--allow-empty', '-m', 'baseline'],
        { cwd: repoPath },
      ),
      'git commit baseline',
    );

    // Capture the baseline OID. This is the value the runner's bundle
    // references as a prerequisite; if the determinism guarantees
    // hold, fetch will succeed in the next step.
    const baselineRevParse = await runGit(
      ['-C', repoPath, 'rev-parse', 'refs/heads/baseline'],
      {},
    );
    await expectOk(baselineRevParse, 'git rev-parse refs/heads/baseline');
    const baselineCommit = baselineRevParse.stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(baselineCommit)) {
      throw new Error(
        `prepareScratchRepo: invalid baseline OID ${JSON.stringify(baselineCommit)}`,
      );
    }

    // -------------------------------------------------------------
    // 2. Load the thin bundle into the scratch repo.
    //
    // The bundle declares baseline as a prerequisite; the fetch
    // succeeds iff the OID we just reconstructed matches the
    // runner's. A mismatch surfaces as "fatal: bad object <oid>" —
    // failure mode is loud, which is what we want when determinism
    // guarantees drift.
    //
    // We fetch into a non-conflicting ref name so it doesn't clobber
    // refs/heads/baseline. `git fetch ... 'refs/heads/*:refs/heads/*'`
    // would do that; instead, route to a private ref.
    // -------------------------------------------------------------
    const bundlePath = join(tmp, 'in.bundle');
    await writeFile(bundlePath, Buffer.from(input.bundleBytes, 'base64'));
    await expectOk(
      await runGit(
        [
          '-C',
          repoPath,
          'fetch',
          '--quiet',
          bundlePath,
          // The runner's bundle is `bundle create - HEAD` so it ships
          // refs/heads/<whatever-the-runner-named-it>. We catch any
          // ref the bundle introduces and route them under
          // refs/bundle/* so we don't collide with our `baseline` ref.
          'refs/heads/*:refs/bundle/*',
        ],
        {},
      ),
      'git fetch bundle',
    );

    // The bundle's tip — what the runner ran `bundle create` with —
    // becomes our HEAD for the verifier and walker. The runner ships
    // exactly one ref tip per turn (refs/heads/main, or refs/heads/
    // baseline pre-advance, or whatever — we pick the one ref that
    // landed under refs/bundle/*).
    const bundleRefs = await runGit(
      ['-C', repoPath, 'for-each-ref', '--format=%(refname)', 'refs/bundle/'],
      {},
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
      // The runner ships exactly one ref tip per turn. Multiple refs
      // would be a contract violation — don't try to guess.
      throw new Error(
        `prepareScratchRepo: bundle introduced ${refList.length} refs (expected exactly 1): ${refList.join(', ')}`,
      );
    }
    // Point HEAD at the bundle's tip so verify/walk can name it as `HEAD`.
    await expectOk(
      await runGit(
        ['-C', repoPath, 'symbolic-ref', 'HEAD', refList[0]!],
        {},
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
