// ---------------------------------------------------------------------------
// claude-sdk runner — git-workspace helpers (Phase 3).
//
// Owns three concerns:
//   1. Materialize /permanent at session start from a host-streamed bundle
//      (or `git init` for brand-new workspaces).
//   2. Stage everything in /permanent at turn end, commit if non-empty,
//      bundle the new commits as `git bundle baseline..HEAD`.
//   3. Roll the working tree back to the baseline ref when the host vetoes
//      a turn, and advance the baseline ref when the host accepts.
//
// All git invocations use the locked-down env baked into the pod by
// `@ax/sandbox-k8s`'s pod-spec (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=
// /dev/null, HOME=/nonexistent, GIT_AUTHOR_*=ax-runner pinned). We do NOT
// re-stamp those env vars here — that's the pod's job and we trust it.
// Re-stamping would split the source of truth and let a future env tweak
// drift between the two callers.
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
 * Spawn `git` with the given args. Inherits the parent process env (so the
 * pod-spec's locked-down env applies). `stdin` is closed; stdout/stderr
 * are captured fully before resolve.
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
    // stderr is git's own diagnostic; safe to include because the runner's
    // stderr is the host's log sink and the host pod is the trust root.
    throw new Error(`${label} failed (exit=${result.code}): ${result.stderr}`);
  }
}

export interface MaterializeInput {
  /** Filesystem path of the workspace root (typically `/permanent`). */
  root: string;
  /** Base64 bundle bytes from `workspace.materialize`; empty = brand-new. */
  bundleBase64: string;
}

/**
 * Initialize `/permanent` as a git working tree.
 *
 * Empty bundle path: `git init` an empty repo. No baseline ref yet — the
 * first turn-end commit creates HEAD; the runner pins `refs/heads/baseline`
 * after the first successful host accept.
 *
 * Non-empty bundle path: `git clone --branch baseline <bundle> <root>`,
 * then pin `refs/heads/baseline` to HEAD locally so the next
 * `git bundle baseline..HEAD` is well-defined.
 *
 * Idempotency note: this is called ONCE per session. Re-calling on a
 * non-empty `/permanent` would fail (`git init` is fine, but `git clone`
 * into a non-empty target fails). Bootstrap-fatal — the runner can't
 * proceed without a clean workspace.
 */
export async function materializeWorkspace(input: MaterializeInput): Promise<void> {
  const { root, bundleBase64 } = input;

  if (bundleBase64 === '') {
    // Brand-new workspace. `git init` (no clone). The default branch
    // doesn't matter for our purposes; we set the baseline ref from
    // the first commit later.
    await fs.mkdir(root, { recursive: true });
    await expectOk(await runGit(['init', root]), 'git init');
    return;
  }

  // Non-empty bundle. Two-step: write the bundle bytes to a temp file
  // OUTSIDE the target dir (clone refuses to clone into a non-empty
  // directory), then clone from the bundle file.
  const parentDir = path.dirname(root);
  await fs.mkdir(parentDir, { recursive: true });
  const bundlePath = `${root}.baseline.bundle`;
  await fs.writeFile(bundlePath, Buffer.from(bundleBase64, 'base64'));
  try {
    await expectOk(
      await runGit(['clone', '--branch', 'baseline', bundlePath, root]),
      'git clone',
    );
    // Pin the local baseline ref to HEAD so `bundle baseline..HEAD` is
    // well-defined at turn end. After clone, HEAD == origin/baseline ==
    // the bundle's baseline tip; this just renames the local ref.
    await expectOk(
      await runGit(['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD']),
      'git update-ref baseline',
    );
  } finally {
    // Best-effort cleanup of the bundle file. If unlink fails (e.g.,
    // already gone), nothing depends on it.
    await fs.rm(bundlePath, { force: true });
  }
}
