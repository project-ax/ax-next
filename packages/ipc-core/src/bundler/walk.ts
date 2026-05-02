// ---------------------------------------------------------------------------
// Bundle → FileChange[] walker (Phase 3).
//
// After verification, the host translates the bundle's commits into the
// canonical `FileChange[]` shape that workspace:apply takes. We use
// `git diff-tree -r --name-status` between the baseline and the bundle's
// tip in the scratch repo prepared by `prepareScratchRepo`.
//
// Output shape:
//   { path, kind: 'put', content }   — added or modified file
//   { path, kind: 'delete' }         — removed file
//
// Renames: `git diff-tree` without `-M` reports renames as `D old.txt`
// + `A new.txt`. We don't enable rename detection (`-M`) deliberately:
//   1. The workspace contract treats rename as delete+add (FileChange
//      doesn't carry a rename kind).
//   2. Rename detection is heuristic (similarity threshold); the
//      naive view is correct-by-construction.
//
// Binary content rides through Buffer; the walker doesn't decode or
// re-encode (UTF-8 vs binary is not the bundler's call — workspace:apply
// stores opaque bytes).
//
// Path namespace: `git diff-tree` reports paths relative to the repo
// root (i.e., relative to /permanent in the runner's view). Workspace
// hooks store relative paths too (per Invariant I1: paths must not leak
// the runner's local mount point). Same shape; no transform needed.
// ---------------------------------------------------------------------------

import type { FileChange } from '@ax/core';
import { expectOk, runGit } from './git-spawn.js';

/**
 * Walk the bundle's commits and produce the canonical FileChange[] for
 * `<baselineCommit>..HEAD` in the prepared scratch repo.
 *
 * Caller owns the scratch repo (created via `prepareScratchRepo`).
 */
export async function walkBundleChanges(input: {
  repoPath: string;
  baselineCommit: string;
}): Promise<FileChange[]> {
  const { repoPath, baselineCommit } = input;

  // `-z` is critical: paths can contain spaces, quotes, etc. The `-z`
  // form delimits with NUL. Each record is `<status>\0<path>\0`.
  // Without `-z`, paths with weird chars come back quoted+escaped.
  const r = await runGit(
    [
      'diff-tree',
      '-r',
      '--no-commit-id',
      '--name-status',
      '-z',
      baselineCommit,
      'HEAD',
    ],
    { cwd: repoPath },
  );
  await expectOk(r, `git diff-tree ${baselineCommit}..HEAD`);

  // Parse pairs: [status, path, status, path, ...]
  // For renames (R/C) git emits 3 fields: status, src, dst — but we
  // don't use rename detection so this is degenerate to A/M/D.
  const tokens = r.stdout
    .toString('utf8')
    .split('\0')
    .filter((s) => s.length > 0);
  const out: FileChange[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (status === undefined || path === undefined) break;
    if (status === 'A' || status === 'M') {
      // Need the new blob's oid. `git ls-tree HEAD <path>` is the
      // simplest path; one extra spawn per file is fine for turn-end
      // diffs (typically O(1)–O(10) files).
      const lt = await runGit(['ls-tree', 'HEAD', path], { cwd: repoPath });
      await expectOk(lt, `git ls-tree HEAD ${path}`);
      const line = lt.stdout.toString('utf8').trim();
      const parts = line.split(/\s+/);
      // Format: `<mode> <type> <oid>\t<path>`. parts[2] is the oid.
      if (parts.length < 3) continue;
      const oid = parts[2]!;
      const content = await readBlob(repoPath, oid);
      out.push({ path, kind: 'put', content });
    } else if (status === 'D') {
      out.push({ path, kind: 'delete' });
    } else {
      // T (type-change file↔symlink, blob↔tree), R (rename), C (copy),
      // U (unmerged), X (unknown). None should appear in the shape we
      // ask for (no -M, no -C, single linear branch). Silently skipping
      // would let the host's view of the workspace diverge from the
      // runner's — better to fail loud and surface the unexpected
      // status as a bug to investigate.
      //
      // Type-change specifically: our FileChange contract carries only
      // bytes (no mode info), so we can't faithfully preserve a
      // file→symlink transition. If we ever need to support that, this
      // is the spot to add a TODO + a real plan.
      throw new Error(
        `walkBundleChanges: unsupported diff-tree status '${status}' for path ${JSON.stringify(path)}`,
      );
    }
  }
  return out;
}

async function readBlob(repoPath: string, oid: string): Promise<Uint8Array> {
  // `git cat-file blob <oid>` writes raw bytes to stdout. We capture
  // as Buffer and return as Uint8Array for the FileChange contract.
  const r = await runGit(['cat-file', 'blob', oid], { cwd: repoPath });
  await expectOk(r, `git cat-file blob ${oid}`);
  return new Uint8Array(r.stdout);
}
