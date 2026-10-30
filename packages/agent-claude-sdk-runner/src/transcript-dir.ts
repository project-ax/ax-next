import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunnerEnv } from '@ax/agent-runner-core';

/**
 * Where the Claude SDK's per-session transcript working copy lives. The DB
 * (host store) is the transcript's source of truth; this directory is only the
 * runner-local copy the SDK appends to and the delta-ship reads from.
 *
 * `transcriptsRoot` (`AX_TRANSCRIPTS_ROOT`) is the sandbox-stamped location:
 * k8s stamps `/tmp/transcripts`, the pod's disk-backed emptyDir, because
 * `/home/runner` is tmpfs and counts against the pod's memory limit. Without
 * one, the SDK's own `$CLAUDE_CONFIG_DIR/projects` is used as-is; under the
 * subprocess sandbox that is already a per-session directory.
 *
 * Every reader and the resume writer take THIS directory (the link target when
 * a root is stamped), never the link path. Because writes go to the target, a
 * restore can never create a real directory at the link path for a later
 * `prepareTranscriptDir`'s `rm -rf` to delete.
 */
export function sdkTranscriptDir(
  env: Pick<RunnerEnv, 'claudeConfigDir' | 'transcriptsRoot'>,
): string {
  return env.transcriptsRoot ?? path.join(env.claudeConfigDir, 'projects');
}

/**
 * Create the transcript directory and, when a transcripts root is stamped, lay
 * `$CLAUDE_CONFIG_DIR/projects` down as a symlink to it.
 *
 * Why a link: the SDK derives its per-session jsonl path from
 * `projectsDir = join(configDir, "projects")`, which is hard-coded (no
 * separable env override), so we redirect the I/O at the filesystem layer. The
 * link lives in `$CLAUDE_CONFIG_DIR`, outside the root, so the target must be
 * the ABSOLUTE path (`readRunnerEnv` guarantees it is).
 *
 * The target is created `0700`: transcripts are the agent's conversation and
 * nothing but the runner's user needs them.
 *
 * Idempotent. A correct symlink already in place is left untouched (so
 * concurrent re-entry doesn't briefly orphan it); anything else at the link
 * path (regular file, dangling link, wrong link, or a directory left by an
 * interrupted previous session) is dropped and recreated. When the root IS
 * `$CLAUDE_CONFIG_DIR/projects` there is nothing to link: it stays a plain
 * directory and keeps its contents.
 *
 * Runs from the `afterMaterialize` seam, so a failure is bootstrap-fatal (exit
 * 2) and happens before the resume restore writes anything.
 */
export async function prepareTranscriptDir(
  env: Pick<RunnerEnv, 'claudeConfigDir' | 'transcriptsRoot'>,
): Promise<void> {
  const target = sdkTranscriptDir(env);
  const linkPath = path.join(env.claudeConfigDir, 'projects');
  // Target dir must exist before the SDK opens a file under it: the SDK's
  // `mkdir(dirname, { recursive: true })` over a link whose target is missing
  // would hit ENOENT on the chain.
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  if (env.transcriptsRoot === undefined || path.resolve(target) === path.resolve(linkPath)) {
    return;
  }
  // Parent of the link: the sandbox usually pre-creates it (an init container
  // or the subprocess spawn), but this must not assume so.
  await fs.mkdir(env.claudeConfigDir, { recursive: true, mode: 0o755 });
  const existing = await fs.readlink(linkPath).catch(() => null);
  if (existing === target) return;
  await fs.rm(linkPath, { recursive: true, force: true });
  try {
    await fs.symlink(target, linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = await fs.readlink(linkPath).catch(() => null);
    if (raced !== target) throw err;
  }
}
