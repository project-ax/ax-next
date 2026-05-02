import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import {
  WorkspaceMaterializeRequestSchema,
  WorkspaceMaterializeResponseSchema,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import { expectOk, runGitDeterministic } from '../bundler/git-spawn.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.materialize
//
// Sandbox -> Host RPC fired ONCE at session start, before the SDK query
// loop opens. The handler produces a `git bundle` over the workspace's
// current state and returns it base64-encoded. The runner unpacks into
// `/permanent` so the agent runs against a real git working tree from
// turn 1.
//
// Implementation strategy: SLOW PATH per Phase 3 plan Q6. The handler
// reconstructs the bundle by walking `workspace:list` + `workspace:read`
// rather than reaching into the workspace plugin's local mirror cache.
// That keeps Invariant I2 (no cross-plugin imports) clean. If profiling
// shows materialize is hot, a future `workspace:bundle` service hook
// can short-circuit; for Phase 3, the reconstruction is correct and the
// once-per-session cost is fine.
//
// DETERMINISM (Phase 3 direct-apply path): the baseline commit MUST be
// reproducible. The runner's per-turn thin bundle (`baseline..HEAD`)
// references this commit OID as a prerequisite; the host needs to
// rebuild the same OID at commit-notify time to load the bundle into
// its scratch repo, AND the workspace plugin's mirror cache needs the
// same OID at its HEAD so it can fetch the bundle directly. Three
// requirements:
//
//   1. Stable input order — paths are sorted before being committed.
//   2. Stable timestamps — GIT_AUTHOR_DATE and GIT_COMMITTER_DATE are
//      pinned to epoch 0 UTC.
//   3. Stable identity — author/committer are pinned to ax-runner.
//
// Empty workspace handling: ALWAYS produce a bundle, even when the
// workspace is empty. We commit `--allow-empty` so the bundle has
// exactly one commit on `refs/heads/baseline` whose tree is git's
// well-known empty-tree OID. The runner clones this and pins
// refs/heads/baseline; subsequent turn-end bundles (`baseline..HEAD`)
// always have a valid prerequisite. Eliminates the empty-bundle wire
// special case on both sides.
//
// Ordering: snapshot of the workspace at "now". `list` and `read` calls
// fan out to whichever workspace plugin is registered; the host
// serializes per-workspace writes elsewhere (Phase 2's per-workspace
// queue), so a concurrent `apply` cannot interleave between our `list`
// and `read` calls in a way that produces an inconsistent bundle.
// ---------------------------------------------------------------------------

/**
 * Build a single-commit `baseline` bundle from a snapshot of the
 * workspace. Returns base64 bytes — never empty (an empty workspace
 * still produces a one-commit bundle with the empty tree).
 *
 * Deterministic: same `(paths, read)` inputs produce the same bundle
 * bytes byte-for-byte. The commit OID is reproducible. Load-bearing for
 * the direct-apply path (Slice 6's commit-notify handler reuses this
 * helper to rebuild the baseline commit at apply time).
 *
 * Pure helper, easy to test in isolation: pass it a list of paths + a
 * read function and it reconstructs the bundle.
 */
export async function buildBaselineBundle(input: {
  paths: readonly string[];
  read: (path: string) => Promise<Buffer | null>;
}): Promise<string> {
  // Sort paths so the input order doesn't perturb the commit OID.
  const sortedPaths = [...input.paths].sort();
  // Drop paths that read returns null for (e.g., listed but deleted
  // between list and read — race-tolerant). The remaining set defines
  // the baseline tree; an empty set is fine — we commit --allow-empty.
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  for (const p of sortedPaths) {
    const bytes = await input.read(p);
    if (bytes === null) continue;
    entries.push({ path: p, bytes });
  }

  const tmp = await mkdtemp(join(tmpdir(), 'ax-mat-'));
  try {
    // Build a real working tree, commit, then bundle. Index-only
    // construction with `git mktree` is faster but harder to get right
    // when paths contain nested directories; the working-tree path is
    // correctness-by-construction.
    //
    // `core.fileMode=false`: makes git ignore the filesystem's
    // executable-bit perception. Every file lands as 100644 in the tree
    // regardless of host umask or filesystem quirks (e.g., NTFS).
    // Required for OID determinism across host environments.
    await expectOk(
      await runGitDeterministic(['init', '-b', 'main', tmp]),
      'git init',
    );
    await expectOk(
      await runGitDeterministic(
        ['config', 'core.fileMode', 'false'],
        { cwd: tmp },
      ),
      'git config core.fileMode',
    );
    for (const { path, bytes } of entries) {
      const abs = join(tmp, path);
      // path.dirname (not lastIndexOf('/')) for cross-platform safety —
      // join() uses OS separators (\ on Windows), and substring slicing
      // on '/' would silently mis-resolve there. dirname handles both.
      const dir = dirname(abs);
      if (dir !== tmp) {
        await mkdir(dir, { recursive: true });
      }
      // mode 0o644: explicit so file creation is deterministic across
      // host umasks. Combined with core.fileMode=false above, the tree
      // OID doesn't depend on the host environment.
      await writeFile(abs, bytes, { mode: 0o644 });
    }
    await expectOk(
      await runGitDeterministic(['add', '-A'], { cwd: tmp }),
      'git add',
    );
    // --allow-empty: the workspace may have nothing in it (brand-new
    // session). We still want a baseline commit so the runner has a
    // valid `refs/heads/baseline` to bundle from. The empty case
    // commits with git's well-known empty-tree (4b825dc6...).
    await expectOk(
      await runGitDeterministic(
        ['commit', '--allow-empty', '-m', 'baseline'],
        { cwd: tmp },
      ),
      'git commit',
    );
    // Bundle to a tempfile (NOT stdout) — runGit's utf8-decoded stdout
    // would mangle binary bundle bytes. The pack format contains
    // arbitrary binary data (deltas, blob bytes); we need raw bytes
    // from the file.
    const bundlePath = join(tmp, 'baseline.bundle');
    await expectOk(
      await runGitDeterministic(
        ['bundle', 'create', bundlePath, 'main'],
        { cwd: tmp },
      ),
      'git bundle create',
    );
    const bytes = await readFile(bundlePath);
    return bytes.toString('base64');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export const workspaceMaterializeHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = WorkspaceMaterializeRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.materialize: ${parsed.error.message}`);
  }

  // List the workspace at HEAD. Empty list is fine — we still produce
  // a bundle with an empty-tree baseline commit so the runner can
  // bundle subsequent turns from a valid `baseline` ref.
  const listed = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    ctx,
    {},
  );

  let bundleBytes: string;
  try {
    bundleBytes = await buildBaselineBundle({
      paths: listed.paths,
      read: async (path) => {
        const r = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
          'workspace:read',
          ctx,
          { path },
        );
        if (!r.found) return null;
        return Buffer.from(r.bytes);
      },
    });
  } catch (err) {
    // Bundle construction failures are sanitized to 500 — the underlying
    // git stderr can echo a temp path or filename, neither of which the
    // sandbox should see in an error envelope. Real diagnostic goes to
    // the host log.
    logInternalError(ctx.logger, 'workspace.materialize', err);
    return internalError();
  }

  const body = { bundleBytes };
  const checked = WorkspaceMaterializeResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'workspace.materialize',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
