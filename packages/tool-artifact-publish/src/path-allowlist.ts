/**
 * Phase 2 — `artifact_publish` tool path-allowlist (design Boundary D).
 *
 * Pure-function path validation. No filesystem access. Reused by both
 * the host plugin's descriptor (for the model-facing `description`) and
 * the runner-side executor (for actual enforcement).
 *
 * Allowed prefixes:
 *  - /permanent/workspace/<sub>        — user project content
 *  - /permanent/.ax/artifacts/<sub>    — explicit artifact namespace
 *
 * Returns a `relativePath` (workspace-relative) on success so the
 * caller stores a path that matches what `workspace:read` expects and
 * what the path-scope ACL in `attachments:download` compares against.
 */

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // 100 MiB

const PERMANENT_PREFIX = '/permanent/';
const ALLOWED_RELATIVE_PREFIXES = ['workspace/', '.ax/artifacts/'];

export type PathCheckResult =
  | { ok: true; relativePath: string }
  | { ok: false; reason: string };

export function checkPublishablePath(absPath: string): PathCheckResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: empty path' };
  }
  if (!absPath.startsWith(PERMANENT_PREFIX)) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must start with ${PERMANENT_PREFIX}`,
    };
  }
  const relative = absPath.slice(PERMANENT_PREFIX.length);
  if (relative.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: no file component' };
  }
  // Traversal defence — reject any '..' segment outright.
  for (const seg of relative.split('/')) {
    if (seg === '..') {
      return { ok: false, reason: 'artifact-path-not-publishable: path contains ..' };
    }
  }
  const prefix = ALLOWED_RELATIVE_PREFIXES.find((p) => relative.startsWith(p));
  if (prefix === undefined) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must be under one of ${ALLOWED_RELATIVE_PREFIXES.map((p) => PERMANENT_PREFIX + p).join(', ')}`,
    };
  }
  if (relative.length === prefix.length) {
    return { ok: false, reason: 'artifact-path-not-publishable: no file component after prefix' };
  }
  return { ok: true, relativePath: relative };
}
