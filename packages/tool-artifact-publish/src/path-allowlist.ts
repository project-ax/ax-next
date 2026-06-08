/**
 * `artifact_publish` tool path-allowlist (TASK-68, out-of-git Part C).
 *
 * Pure-function path validation. No filesystem access. Reused by both the host
 * plugin's descriptor (for the model-facing `description`) and the runner-side
 * executor (for actual enforcement).
 *
 * The artifact namespace moved OFF git (`/agent/.ax/artifacts/`) onto the
 * disposable `/ephemeral` tier — artifacts are published to the content-addressed
 * blob store at `artifact_publish` time, not swept into a git commit. So the
 * allowlist now spans TWO sandbox roots:
 *
 *  - `/ephemeral/artifacts/<sub>`  — the primary artifact namespace (scratch;
 *                                    bytes go to blob:put on publish).
 *  - `/agent/workspace/<sub>`      — the rare Pattern A case: ax-hosted project
 *                                    code under git may still publish a snapshot
 *                                    as an artifact (an intentional double-home —
 *                                    git holds editable history, the blob holds
 *                                    the immutable shared snapshot).
 *
 * Returns which `root` (`ephemeral` | `agent`) the path lives under plus the
 * root-relative `relativePath`, so the executor maps it onto the right
 * filesystem root and the host stores a stable display/scope key.
 */

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // 100 MiB

export type PublishRoot = 'ephemeral' | 'agent';

interface RootSpec {
  root: PublishRoot;
  /** Sandbox-absolute prefix, e.g. `/ephemeral/`. */
  prefix: string;
  /** Allowed relative prefixes under the root. */
  allowed: string[];
}

const ROOTS: RootSpec[] = [
  { root: 'ephemeral', prefix: '/ephemeral/', allowed: ['artifacts/'] },
  { root: 'agent', prefix: '/agent/', allowed: ['workspace/'] },
];

export type PathCheckResult =
  | { ok: true; root: PublishRoot; relativePath: string }
  | { ok: false; reason: string };

const ALLOWED_DESC = '/ephemeral/artifacts/**, /agent/workspace/**';

export function checkPublishablePath(absPath: string): PathCheckResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: empty path' };
  }
  const spec = ROOTS.find((r) => absPath.startsWith(r.prefix));
  if (spec === undefined) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must be under one of ${ALLOWED_DESC}`,
    };
  }
  const relative = absPath.slice(spec.prefix.length);
  if (relative.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: no file component' };
  }
  // Traversal defence — reject any '..' segment outright.
  for (const seg of relative.split('/')) {
    if (seg === '..') {
      return { ok: false, reason: 'artifact-path-not-publishable: path contains ..' };
    }
  }
  const allowedPrefix = spec.allowed.find((p) => relative.startsWith(p));
  if (allowedPrefix === undefined) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must be under one of ${ALLOWED_DESC}`,
    };
  }
  if (relative.length === allowedPrefix.length) {
    return { ok: false, reason: 'artifact-path-not-publishable: no file component after prefix' };
  }
  return { ok: true, root: spec.root, relativePath: relative };
}
