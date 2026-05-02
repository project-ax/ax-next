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
      await runGit(['clone', '--branch', 'baseline', bundlePath, root]),
      'git clone',
    );
    // After clone, HEAD is a symbolic ref to refs/heads/baseline. We
    // need to MOVE OFF baseline so subsequent turn-end commits advance
    // a different ref, leaving baseline pinned to the materialize tip.
    // `git checkout -b main` creates `main` from current HEAD and
    // switches; `refs/heads/baseline` stays where it is.
    //
    // After this, the contract is:
    //   refs/heads/baseline   — the materialize tip (advances per turn
    //                           via advanceBaseline after host accepts).
    //   HEAD/refs/heads/main  — current working state; advances on each
    //                           turn-end commit.
    //   git bundle baseline..HEAD — the per-turn diff.
    await expectOk(
      await runGit(['-C', root, 'checkout', '-b', 'main']),
      'git checkout -b main',
    );
  } finally {
    // Best-effort cleanup of the bundle file. If unlink fails (e.g.,
    // already gone), nothing depends on it.
    await fs.rm(bundlePath, { force: true });
  }
}
