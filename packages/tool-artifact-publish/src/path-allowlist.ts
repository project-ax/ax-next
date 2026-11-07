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
 * WHAT IS PUBLISHABLE: `<userFilesRoot>/**`, the agent's files folder, whole.
 * It is the agent's cwd and HOME, it holds nothing but the agent's own files by
 * construction, and the returned `relativePath` is the artifact's re-publish
 * key, the same key the Files tab lists the file by.
 *
 * WHAT IS NOT: everything else. The scratch root's old `artifacts/` namespace
 * was dropped (C2): an artifact is a file the person can find again in /files,
 * and the scratch root's `uploads/` originals, `transcripts/`, venv and caches
 * are structurally out of reach of a prompt-injected "publish your transcript"
 * attempt. The `/agent/workspace/**` fossil went long ago (TASK-995).
 */

import * as path from 'node:path';

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // 100 MiB

/**
 * The runtime root to validate against. Optional: a deployment that wires no
 * files folder has nothing to publish from, which is what the caller is told.
 */
export interface PublishRoots {
  /** `AX_USERFILES_ROOT` — the agent's files folder. Publishable in full. */
  userFilesRoot?: string;
}

export type PathCheckResult =
  | {
      ok: true;
      /** Absolute root the path resolved under — the executor reads from here. */
      base: string;
      /** Path relative to `base`: the re-publish key the host stores. */
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

  const { userFilesRoot } = roots;
  if (userFilesRoot !== undefined) {
    const rel = containedRelative(absPath, userFilesRoot);
    if (rel !== null) {
      return { ok: true, base: trimTrailingSlashes(path.resolve(userFilesRoot)), relativePath: rel };
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
  if (roots.userFilesRoot === undefined) {
    return 'this deployment has no publishable location wired';
  }
  return `path must be under ${trimTrailingSlashes(roots.userFilesRoot)}/**`;
}
