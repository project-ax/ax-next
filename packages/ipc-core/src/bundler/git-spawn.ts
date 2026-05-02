// ---------------------------------------------------------------------------
// Internal shared `git` spawn helpers for the host-side bundler.
//
// Two shapes:
//
//   runGit(args)              — read-only git ops (cat-file, rev-list,
//                               diff-tree, ls-tree). Pinned env, no
//                               author identity, no fixed dates.
//
//   runGitDeterministic(args) — write ops that must produce reproducible
//                               commit OIDs (init, commit, hash-object).
//                               Layers GIT_AUTHOR_*/GIT_COMMITTER_* and
//                               fixed epoch dates on top of the read env.
//
// Both helpers spawn with PATH fixed to the host pod's image-default
// binary directories. We do NOT inherit process.env.PATH — a maliciously
// placed `git` in the host pod's environment would defeat the whole
// point of bundle-author verification.
//
// Trust model: stderr is git's own diagnostic. The host pod is the
// trust root for the binary; we do NOT echo stderr to the runner over
// the wire (the handler sanitizes errors before responding). Caller
// decides whether a non-zero exit is fatal.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Read-only env. Used by verify/walk where we never write a commit.
 * Author identity isn't relevant; date pinning isn't relevant.
 */
const HOST_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/local/bin:/usr/bin:/bin',
};

/**
 * Deterministic-write env. Used by buildBaselineBundle and any other
 * commit-writing path where the resulting OID must be reproducible
 * across host invocations.
 *
 * Pinning every component of a commit object's identity:
 *   - author/committer NAME and EMAIL — the runner pod uses the same
 *     values, so the host's reconstructed baseline matches the
 *     runner's cloned baseline.
 *   - author/committer DATE — `0 +0000` (1970-01-01 UTC). Any fixed
 *     value works; epoch is the conventional "this is synthesized,
 *     not real wall time" choice.
 *
 * Combined with sorted-paths input + `core.fileMode=false` + explicit
 * 0o644 file mode + git's normal canonical commit serialization, the
 * resulting commit OID is bit-for-bit reproducible.
 */
// ISO 8601, UTC, epoch. Git's date parser accepts ISO 8601 over the
// env vars; the "internal" `<unix_ts> <tz>` format is only used for
// commit-object SERIALIZATION, not for input. Choosing the epoch keeps
// the synthesized commits visually distinct from real wall-time
// commits in any `git log` output.
const BASELINE_DATE = '1970-01-01T00:00:00Z';
const HOST_GIT_DETERMINISTIC_ENV: NodeJS.ProcessEnv = {
  ...HOST_GIT_ENV,
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
  GIT_AUTHOR_DATE: BASELINE_DATE,
  GIT_COMMITTER_DATE: BASELINE_DATE,
};

function spawnGit(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  opts: { cwd?: string },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      env,
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

export function runGit(
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<GitResult> {
  return spawnGit(HOST_GIT_ENV, args, opts);
}

export function runGitDeterministic(
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<GitResult> {
  return spawnGit(HOST_GIT_DETERMINISTIC_ENV, args, opts);
}

export async function expectOk(result: GitResult, label: string): Promise<void> {
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit=${result.code}): ${result.stderr}`);
  }
}
