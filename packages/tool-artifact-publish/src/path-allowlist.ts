/**
 * `artifact_publish` path allowlist.
 *
 * Pure-function path validation — no filesystem access, so it cannot resolve
 * symlinks. The executor performs the containment re-check that needs I/O (see
 * `artifact-publish-executor.ts`); this module is the textual gate in front of it.
 *
 * ROOTS ARE RUNTIME VALUES, NOT LITERALS. The prior version hardcoded the
 * sandbox-absolute prefixes `/ephemeral/` and `/agent/` while the executor
 * mapped them back through the env roots. That only lines up on k8s, where the
 * mount paths happen to BE those literals. In the subprocess sandbox the roots
 * are `mkdtemp` paths, so the model — which is told its real roots in the
 * operating notes — passed a real path and got it rejected, while the advertised
 * `/ephemeral/artifacts/...` named a directory it could not have written to.
 * Parameterising on the roots is the same shape `@ax/tool-skill-propose`'s
 * `checkDraftPath(absPath, root)` already uses, and it works in both sandboxes.
 *
 * WHAT IS PUBLISHABLE:
 *
 *  - `<userFilesRoot>/**` — the durable per-agent tier, whole. It is the agent's
 *    cwd and HOME, it holds nothing but user content by construction, and it is
 *    where the operating notes tell the agent to put anything it wants to keep.
 *    A deliverable written to the working directory is the overwhelmingly common
 *    case, and it was the one case the old allowlist rejected.
 *  - `<ephemeralRoot>/artifacts/**` — the scratch artifact namespace, unchanged.
 *    Still a subdirectory rather than the whole tier: `/ephemeral` also holds the
 *    python venv, tool caches and build trees, none of which are deliverables.
 *
 * WHAT IS NOT, AND WHY THE GOVERNED TIER LEFT ENTIRELY: the old list carried
 * `/agent/workspace/**`, described as "the rare Pattern A case: ax-hosted project
 * code under git". That entry is a fossil of the pre-split layout, where the
 * single tier was `/permanent` and `/permanent/workspace/**` WAS the user's file
 * area. The `/permanent`→`/agent` rename kept the string, the filestore split
 * moved user files to their own mount, and the allowlist was never revisited —
 * so it pointed at a directory nothing in the repo creates. Dropping it removes
 * the phantom AND tightens the floor: no path under the governed tier is
 * publishable now, so the agent's own `.ax/` identity + memory, its `.claude/`
 * transcripts and the `.ax/uploads/` originals are all structurally out of reach
 * of a prompt-injected "publish your instructions" attempt.
 */

import * as path from 'node:path';

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // 100 MiB

/**
 * Longest accepted `displayName`. The model chooses this string and it is stored
 * and rendered as the artifact's label, so it is bounded here rather than left to
 * whatever the model emits. Generous for a filename, far below anything that
 * would bloat a row or a chat bubble.
 */
export const MAX_DISPLAY_NAME_CHARS = 256;

/** Which tier a publishable path resolved against. */
export type PublishRoot = 'user-files' | 'ephemeral';

/** The scratch tier's artifact namespace — the only publishable part of it. */
const EPHEMERAL_ARTIFACTS_SUBDIR = 'artifacts';

/**
 * The runtime roots to validate against. Both optional and independent: a
 * deployment may wire a durable mount, a scratch tier, both, or neither, and the
 * allowlist is exactly the roots that are present. Absent roots are not "denied"
 * — they simply do not exist to publish from, which is what the caller is told.
 */
export interface PublishRoots {
  /** `AX_USERFILES_ROOT` — durable per-agent tier. Publishable in full. */
  userFilesRoot?: string;
  /** `AX_EPHEMERAL_ROOT` — session scratch. Only `<root>/artifacts/**`. */
  ephemeralRoot?: string;
}

export type PathCheckResult =
  | {
      ok: true;
      root: PublishRoot;
      /** Absolute root the path resolved under — the executor reads from here. */
      base: string;
      /** Path relative to `base`. The stable display/scope key the host stores. */
      relativePath: string;
    }
  | { ok: false; reason: string };

/** Strip trailing slashes without a backtracking regex (this takes model input). */
function trimTrailingSlashes(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Resolve `absPath` under `base` and return the relative tail, or null when it
 * escapes. Textual only — `path.resolve` normalises `..` and `.` so a traversal
 * cannot survive it, and the explicit prefix test then rejects a sibling whose
 * name merely starts with the root (`/filesX` must not match `/files`).
 */
function containedRelative(absPath: string, base: string): string | null {
  const normalisedBase = trimTrailingSlashes(path.resolve(base));
  const resolved = path.resolve(absPath);
  if (resolved === normalisedBase) return null; // the root itself is not a file
  if (!resolved.startsWith(normalisedBase + path.sep)) return null;
  return resolved.slice(normalisedBase.length + 1);
}

/**
 * Validate a model-supplied absolute path against the session's real roots.
 *
 * Returns the `base` it resolved under plus the root-relative tail, so the
 * executor joins exactly what was validated instead of re-deriving it from a
 * second mapping table (the old `rootBaseFor`, which is what let the literal
 * prefixes and the real roots drift apart in the first place).
 */
export function checkPublishablePath(
  absPath: string,
  roots: PublishRoots,
): PathCheckResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: empty path' };
  }
  if (!path.isAbsolute(absPath)) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must be absolute (${describeRoots(roots)})`,
    };
  }

  const { userFilesRoot, ephemeralRoot } = roots;

  if (userFilesRoot !== undefined) {
    const rel = containedRelative(absPath, userFilesRoot);
    if (rel !== null) {
      return {
        ok: true,
        root: 'user-files',
        base: trimTrailingSlashes(path.resolve(userFilesRoot)),
        relativePath: rel,
      };
    }
  }

  if (ephemeralRoot !== undefined) {
    const artifactsBase = path.join(
      trimTrailingSlashes(path.resolve(ephemeralRoot)),
      EPHEMERAL_ARTIFACTS_SUBDIR,
    );
    const rel = containedRelative(absPath, artifactsBase);
    if (rel !== null) {
      return {
        ok: true,
        root: 'ephemeral',
        base: artifactsBase,
        relativePath: rel,
      };
    }
  }

  return {
    ok: false,
    reason: `artifact-path-not-publishable: ${describeRoots(roots)}`,
  };
}

/**
 * The human/model-readable statement of what IS publishable in this session.
 * Built from the live roots so a rejection names paths the agent actually has,
 * never a literal from another deployment shape.
 */
export function describeRoots(roots: PublishRoots): string {
  const parts: string[] = [];
  if (roots.userFilesRoot !== undefined) {
    parts.push(`${trimTrailingSlashes(roots.userFilesRoot)}/**`);
  }
  if (roots.ephemeralRoot !== undefined) {
    parts.push(
      `${trimTrailingSlashes(roots.ephemeralRoot)}/${EPHEMERAL_ARTIFACTS_SUBDIR}/**`,
    );
  }
  if (parts.length === 0) {
    return 'this deployment has no publishable location wired';
  }
  return `path must be under one of ${parts.join(', ')}`;
}
