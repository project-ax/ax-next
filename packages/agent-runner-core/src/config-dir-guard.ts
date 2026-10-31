// ---------------------------------------------------------------------------
// CLAUDE_CONFIG_DIR startup guard (TASK-994, design §11).
//
// The SDK loads `$CLAUDE_CONFIG_DIR` as its own trusted configuration:
// settings.json (hooks), CLAUDE.md, skills, and MCP servers in `.claude.json`.
// Both runners also read installed skills and connector `.mcp.json` files from
// it. The agent's home — the durable `/files` mount (`AX_USERFILES_ROOT`,
// required since TASK-995) — is where the agent writes freely. If the two
// overlap, a file the agent writes becomes trusted configuration: in this
// session, and in every later one, because the home is durable. So the runner
// refuses to start.
//
// Both sides are compared as real paths, so a symlink on either side (or a
// platform alias such as macOS /var -> /private/var) cannot hide an overlap.
// A path with a `..` segment is refused before any of that: `link/..` reads
// as one directory and lands in another, depending on where `link` points.
// The config dir must already exist: the sandbox creates it before it starts
// the runner, and creating it here would mean writing before refusing.
//
// `AX_TRANSCRIPTS_ROOT`, when set, gets the same check: the CLI reads
// `$CLAUDE_CONFIG_DIR/projects` back on resume, and that directory then links
// into the transcripts root, so a root in the agent's home would be an
// agent-writable place the CLI loads from. It may not exist yet (the runner
// creates it later), so it is resolved like a missing home.
//
// The home is the only root checked. The scratch root (`AX_EPHEMERAL_ROOT`,
// k8s `/tmp`) is deliberately not: it is never the home any more, it holds the
// transcripts root by design (k8s `/tmp/transcripts`), and it is gone with the
// session, so nothing planted there reaches a later one. (A conversation's
// resume rewrites its transcript there from the host store before the SDK
// starts.)
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runnerHomeDir, type RunnerEnv } from './env.js';

/**
 * Throws when `env.claudeConfigDir` does not exist, or when its real path is
 * the agent's home, inside it, or contains it; and likewise when
 * `env.transcriptsRoot` is set and overlaps the agent's home. Also throws when
 * any of those paths (or the home) has a `..` segment or cannot be
 * resolved. Every message starts with `refusing to start: ` followed by the
 * input at fault: `CLAUDE_CONFIG_DIR`, `AX_TRANSCRIPTS_ROOT`, or
 * `the agent's home (` for the home.
 */
export async function assertConfigDirOutsideAgentHome(
  env: Pick<RunnerEnv, 'claudeConfigDir' | 'transcriptsRoot' | 'userFilesRoot'>,
): Promise<void> {
  const home = runnerHomeDir(env);
  refuseDotDot(env.claudeConfigDir, 'CLAUDE_CONFIG_DIR');
  if (env.transcriptsRoot !== undefined) refuseDotDot(env.transcriptsRoot, 'AX_TRANSCRIPTS_ROOT');
  refuseDotDot(home, "the agent's home");

  let realConfig: string;
  try {
    realConfig = await fs.realpath(env.claudeConfigDir);
  } catch (err) {
    throw new Error(
      `refusing to start: CLAUDE_CONFIG_DIR (${env.claudeConfigDir}) does not exist or cannot be resolved (${errnoOf(err)}). ` +
        'The sandbox creates it before starting the runner, so a missing one means the sandbox is misconfigured.',
    );
  }

  const realHome = await realpathOfPossiblyMissing(home, "the agent's home");
  if (overlaps(realConfig, realHome)) {
    throw new Error(
      `refusing to start: CLAUDE_CONFIG_DIR resolves to ${realConfig}, which overlaps the agent's home ${realHome}. ` +
        'Anything the agent writes there (settings.json hooks, CLAUDE.md, skills, MCP servers in .claude.json) ' +
        "would load as the SDK's own trusted configuration. Point CLAUDE_CONFIG_DIR at a runner-private " +
        "directory outside the agent's files (k8s: /home/runner/.ax/session).",
    );
  }

  if (env.transcriptsRoot === undefined) return;
  const realTranscripts = await realpathOfPossiblyMissing(env.transcriptsRoot, 'AX_TRANSCRIPTS_ROOT');
  if (overlaps(realTranscripts, realHome)) {
    throw new Error(
      `refusing to start: AX_TRANSCRIPTS_ROOT resolves to ${realTranscripts}, which overlaps the agent's home ${realHome}. ` +
        'The SDK reads session transcripts back from there on resume, so the agent could plant one. ' +
        "Point AX_TRANSCRIPTS_ROOT at a runner-private directory outside the agent's files (k8s: /tmp/transcripts).",
    );
  }
}

/**
 * Throws when `p` has a `..` segment. `path.resolve` collapses `link/..` by
 * spelling, but the kernel follows `link` first and steps up from where it
 * lands, so the lexical reading can name the wrong directory. No sandbox
 * builds a guarded path with `..` in it, so this refuses rather than guessing.
 */
function refuseDotDot(p: string, label: string): void {
  if (p.split(/[\\/]/).includes('..')) {
    throw new Error(
      `refusing to start: ${label} (${p}) contains a '..' segment, so its real location cannot be checked. ` +
        'Use an absolute path without `..`.',
    );
  }
}

/** One path is the other, or lies beneath it. */
function overlaps(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

/**
 * The real path of `p`. When `p` does not exist yet, the real path of its
 * deepest existing ancestor with the remaining segments appended. A home the
 * sandbox has not created yet still compares correctly when its path runs
 * through a symlink — a plain `path.resolve` would miss a home that would land
 * inside the config dir that way.
 *
 * Only ENOENT falls back to the parent. Any other error (EACCES, ELOOP,
 * ENOTDIR, ...) means the real path is unknowable, so this throws a
 * `refusing to start: <label>` error instead of comparing a guess.
 */
async function realpathOfPossiblyMissing(p: string, label: string): Promise<string> {
  const resolve = async (abs: string): Promise<string> => {
    try {
      return await fs.realpath(abs);
    } catch (err) {
      const code = errnoOf(err);
      if (code !== 'ENOENT') {
        throw new Error(
          `refusing to start: ${label} (${p}) cannot be resolved: ${abs} gave ${code}. ` +
            'Without its real path the overlap check cannot run.',
        );
      }
      const parent = path.dirname(abs);
      if (parent === abs) return abs;
      return path.join(await resolve(parent), path.basename(abs));
    }
  };
  return resolve(path.resolve(p));
}

/** The errno code of a filesystem error (`ENOENT`, `ELOOP`, ...), or `unknown error`. */
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** `child` is `parent` or lies beneath it. Names like `..foo` and a `/` parent are handled. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
