// ---------------------------------------------------------------------------
// claude-sdk runner — git-workspace helpers (Phase 3).
//
// Owns three concerns:
//   1. Materialize /permanent at session start by cloning the
//      host-streamed baseline bundle.
//   2. Stage everything in /permanent at turn end, commit if non-empty,
//      bundle the new commits as `git bundle baseline..HEAD`.
//   3. Roll the working tree back to the baseline ref when the host
//      vetoes a turn, and advance the baseline ref when the host
//      accepts.
//
// All git invocations use the locked-down env baked into the pod by
// `@ax/sandbox-k8s`'s pod-spec (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=
// /dev/null, HOME=/nonexistent, GIT_AUTHOR_*=ax-runner pinned). We do
// NOT re-stamp those env vars here — that's the pod's job and we trust
// it. Re-stamping would split the source of truth and let a future env
// tweak drift between the two callers.
//
// Spawn discipline: every git invocation goes through a single `spawn`
// helper that captures stdout+stderr separately, never echoes either to
// the runner's own stderr, and returns the buffers to the caller. The
// caller decides whether to surface a failure as fatal or recoverable.
// This is the same shape the host-side bundler uses — keep them aligned.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Spawn `git` with the given args. Inherits the parent process env (so
 * the pod-spec's locked-down env applies). `stdin` is closed;
 * stdout/stderr are captured fully before resolve.
 */
function runGit(
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function expectOk(result: SpawnResult, label: string): Promise<void> {
  if (result.code !== 0) {
    // stderr is git's own diagnostic; safe to include because the
    // runner's stderr is the host's log sink and the host pod is the
    // trust root.
    throw new Error(`${label} failed (exit=${result.code}): ${result.stderr}`);
  }
}

export interface MaterializeInput {
  /** Filesystem path of the workspace root (typically `/permanent`). */
  root: string;
  /** Base64 bundle bytes from `workspace.materialize`. Always non-empty. */
  bundleBase64: string;
}

/**
 * Initialize `/permanent` as a git working tree by cloning a
 * host-streamed baseline bundle.
 *
 * Phase 3 always-bundle: the host's `workspace.materialize` ALWAYS ships
 * a non-empty bundle (one commit on `refs/heads/baseline`, possibly
 * with an empty tree for brand-new workspaces). The runner therefore
 * always clones — no `git init` path. Symmetric with the host side.
 *
 * After clone, `refs/heads/baseline` is pinned locally to HEAD so the
 * next `git bundle baseline..HEAD` is well-defined. Subsequent turns
 * advance the baseline ref via `advanceBaseline` after the host accepts.
 *
 * Idempotency note: this is called ONCE per session. Re-calling on a
 * non-empty `/permanent` would fail (`git clone` refuses a non-empty
 * target). Bootstrap-fatal — the runner can't proceed without a clean
 * workspace.
 */
export async function materializeWorkspace(input: MaterializeInput): Promise<void> {
  const { root, bundleBase64 } = input;

  if (bundleBase64 === '') {
    // Defensive: the wire contract says materialize ALWAYS ships a
    // non-empty bundle. An empty bundle here means the host bundler is
    // broken or the wire was tampered with — fail loud rather than
    // silently producing an unworkable workspace.
    throw new Error(
      'materializeWorkspace: empty bundleBase64 (host should always ship a baseline bundle)',
    );
  }

  // Two-step: write the bundle bytes to a temp file OUTSIDE the target
  // dir (clone refuses to clone into a non-empty directory), then clone
  // from the bundle file.
  const parentDir = path.dirname(root);
  await fs.mkdir(parentDir, { recursive: true });
  const bundlePath = `${root}.baseline.bundle`;
  await fs.writeFile(bundlePath, Buffer.from(bundleBase64, 'base64'));
  try {
    await expectOk(
      await runGit(['clone', '--branch', 'main', bundlePath, root]),
      'git clone',
    );
    // Pin refs/heads/baseline to current HEAD (= main = bundle's tip)
    // so the next `git bundle baseline..main` is well-defined.
    // refs/heads/baseline doesn't exist after clone (the bundle only
    // ships refs/heads/main); we create it here pinning to the same
    // OID as main.
    //
    // After this, the contract is:
    //   refs/heads/baseline   — the last-accepted state (advances per
    //                           turn via advanceBaseline after host
    //                           accepts).
    //   HEAD/refs/heads/main  — current working state; advances on each
    //                           turn-end commit.
    //   git bundle baseline..main main — the per-turn thin bundle.
    await expectOk(
      await runGit(['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD']),
      'git update-ref refs/heads/baseline',
    );
  } finally {
    // Best-effort cleanup of the bundle file. If unlink fails (e.g.,
    // already gone), nothing depends on it.
    await fs.rm(bundlePath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Turn-end helpers (Phase 3 Slice 7).
//
// At each SDK `result` boundary, the runner:
//   1. Stages everything in /permanent (`git add -A`) — catches whatever
//      the agent wrote, regardless of which tool wrote it. Bash deletes,
//      MCP writes, the SDK's internal jsonl: ALL of it.
//   2. Detects empty turn (no staged changes) → returns null bundle so
//      the runner skips the commit-notify call.
//   3. Otherwise commits + bundles `baseline..main main` (thin bundle
//      with the new tip ref). Returns base64 bytes.
//
// After the host responds:
//   - Accepted: `advanceBaseline` moves refs/heads/baseline to HEAD so
//     the next turn's bundle starts from the new state.
//   - Rejected/vetoed: `rollbackToBaseline` resets working tree + HEAD
//     to baseline, undoing the agent's writes for the failed turn. The
//     SDK doesn't see the rollback (it's in the runner's local repo);
//     the agent's next turn starts from a clean baseline.
// ---------------------------------------------------------------------------

/**
 * Stage `/permanent`, commit if non-empty, build a thin bundle of the
 * new commit(s).
 *
 * Returns the bundle as base64 bytes, OR null if the turn wrote nothing
 * (no staged changes after `git add -A`). Caller should skip the
 * commit-notify IPC call when null.
 */
export async function commitTurnAndBundle(input: {
  root: string;
  reason: string;
}): Promise<string | null> {
  const { root, reason } = input;

  // Stage everything. `-A` catches additions, modifications, AND
  // deletions — the load-bearing improvement over PostToolUse-based
  // observation, which only saw additions/modifications via the SDK's
  // Write/Edit/MultiEdit tools.
  await expectOk(await runGit(['-C', root, 'add', '-A']), 'git add');

  // Empty-turn detection: `git diff --cached --quiet` exits 0 when
  // there are no staged changes, 1 when there are. We use this rather
  // than parsing `git status` output — exit code is an authoritative
  // signal that doesn't depend on porcelain format stability.
  const status = await runGit(
    ['-C', root, 'diff', '--cached', '--quiet'],
    {},
  );
  if (status.code === 0) {
    // Empty turn — no commits, no bundle.
    return null;
  }
  if (status.code !== 1) {
    // Anything other than 0 or 1 is an error from git itself.
    throw new Error(
      `git diff --cached --quiet failed (exit=${status.code}): ${status.stderr}`,
    );
  }

  // Commit. Author + committer come from the pod-spec env (ax-runner
  // pinned). The host bundler verifies this; a missing or wrong
  // identity would surface as accepted:false at the host.
  await expectOk(
    await runGit(['-C', root, 'commit', '-m', reason]),
    'git commit',
  );

  // Bundle `baseline..main main` — thin bundle with the new tip ref.
  //   - `baseline..main` is the rev range (commits since the last
  //     accepted state).
  //   - `main` (no `refs/heads/` prefix needed) makes the bundle ship
  //     refs/heads/main pointing at the tip. The host's
  //     `fetchBundleIntoMirror` looks for refs/heads/* via its
  //     refspec; without this trailing arg the bundle has no refs and
  //     the host rejects "bundle introduced 0 refs".
  //
  // Bundle to a tempfile (NOT to stdout) — Node's child_process stdio
  // can re-encode binary output via the default `'utf8'` decoder if a
  // listener attaches before raw bytes flow. Tempfile path is
  // unambiguous and trivially correct. Place it outside `root` so
  // `git add -A` on the next turn doesn't accidentally stage it.
  const bundlePath = `${root}.turn.bundle`;
  await expectOk(
    await runGit(
      ['-C', root, 'bundle', 'create', bundlePath, 'baseline..main', 'main'],
    ),
    'git bundle create',
  );
  try {
    const bytes = await fs.readFile(bundlePath);
    return bytes.toString('base64');
  } finally {
    await fs.rm(bundlePath, { force: true });
  }
}

/**
 * Move `refs/heads/baseline` to current HEAD. Call this AFTER the host
 * accepts a turn — the agent's view of "what's locked in" advances.
 *
 * Subsequent turns bundle `baseline..main` against the new baseline,
 * shipping only the next turn's changes.
 */
export async function advanceBaseline(root: string): Promise<void> {
  await expectOk(
    await runGit(
      ['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD'],
    ),
    'git update-ref baseline -> HEAD',
  );
}

/**
 * Roll the working tree + HEAD back to `refs/heads/baseline`. Call this
 * after the host vetoes a turn — the agent's writes for that turn are
 * undone.
 *
 * `git reset --hard baseline` does both: moves HEAD/main to baseline,
 * AND wipes the working tree to match. The agent's next turn starts
 * from a clean baseline state.
 *
 * The SDK doesn't see the rollback. Its in-memory view of the
 * conversation continues, but its NEXT tool call to read a file would
 * see the baseline content (not the rolled-back content). Whether that
 * causes confusion is up to the agent / the system prompt; the runner
 * just enforces the host's veto.
 */
export async function rollbackToBaseline(root: string): Promise<void> {
  await expectOk(
    await runGit(['-C', root, 'reset', '--hard', 'baseline']),
    'git reset --hard baseline',
  );
}
