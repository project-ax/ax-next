// ---------------------------------------------------------------------------
// CLAUDE_CONFIG_DIR startup guard (TASK-994, design §11).
//
// The SDK loads `$CLAUDE_CONFIG_DIR` as its own trusted configuration:
// settings.json (hooks), CLAUDE.md, skills, and MCP servers in `.claude.json`.
// Both runners also read installed skills and connector `.mcp.json` files from
// it. The agent's home — the durable `/files` mount, or session scratch when no
// durable mount is wired — is where the agent writes freely. If the two
// overlap, a file the agent writes becomes trusted configuration: in this
// session, and in every later one when the home is durable. So the runner
// refuses to start.
//
// Both sides are compared as real paths, so a symlink on either side (or a
// platform alias such as macOS /var -> /private/var) cannot hide an overlap.
// The config dir must already exist: the sandbox creates it before it starts
// the runner, and creating it here would mean writing before refusing.
//
// Deliberately not checked: the governed workspace root (TASK-995 removes it,
// and the pre-apply vetoes gate `.claude/**` writes there until then), and a
// scratch tier that is not the home.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runnerHomeDir, type RunnerEnv } from './env.js';

/**
 * Throws when `env.claudeConfigDir` does not exist, or when its real path is
 * the agent's home, inside it, or contains it. Every message starts with
 * `refusing to start: CLAUDE_CONFIG_DIR`.
 */
export async function assertConfigDirOutsideAgentHome(
  env: Pick<RunnerEnv, 'claudeConfigDir' | 'userFilesRoot' | 'ephemeralRoot' | 'workspaceRoot'>,
): Promise<void> {
  let realConfig: string;
  try {
    realConfig = await fs.realpath(env.claudeConfigDir);
  } catch {
    throw new Error(
      `refusing to start: CLAUDE_CONFIG_DIR (${env.claudeConfigDir}) does not exist or cannot be resolved. ` +
        'The sandbox creates it before starting the runner, so a missing one means the sandbox is misconfigured.',
    );
  }

  const roots = new Set(
    [runnerHomeDir(env), env.userFilesRoot].filter((root): root is string => root !== undefined),
  );
  for (const root of roots) {
    const realRoot = await realpathOfPossiblyMissing(root);
    if (isSameOrInside(realConfig, realRoot) || isSameOrInside(realRoot, realConfig)) {
      throw new Error(
        `refusing to start: CLAUDE_CONFIG_DIR resolves to ${realConfig}, which overlaps the agent's home ${realRoot}. ` +
          'Anything the agent writes there (settings.json hooks, CLAUDE.md, skills, MCP servers in .claude.json) ' +
          "would load as the SDK's own trusted configuration. Point CLAUDE_CONFIG_DIR at a runner-private " +
          "directory outside the agent's files (k8s: /home/runner/.ax/session).",
      );
    }
  }
}

/**
 * The real path of `p`. When `p` does not exist yet, the real path of its
 * deepest existing ancestor with the remaining segments appended. A home the
 * sandbox has not created yet still compares correctly when its path runs
 * through a symlink — a plain `path.resolve` would miss a home that would land
 * inside the config dir that way.
 */
async function realpathOfPossiblyMissing(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(await realpathOfPossiblyMissing(parent), path.basename(abs));
  }
}

/** `child` is `parent` or lies beneath it. Names like `..foo` and a `/` parent are handled. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
