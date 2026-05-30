/**
 * `skill_propose` draft-dir path allowlist (TASK-74, out-of-git Part D / §D1).
 *
 * Pure-function path validation. No filesystem access. Reused by the runner-side
 * executor (for actual enforcement) and available to the host descriptor for the
 * model-facing `description`.
 *
 * Skill authoring is confined to `/ephemeral/skill-draft/<id>/` — disposable
 * scratch git never sees (Part C), so a failed/abandoned author leaves nothing
 * to roll back. The model passes the draft DIRECTORY (not a file); the executor
 * then reads `SKILL.md` + extra files from it.
 *
 * `<id>` must match the strict installable-skill grammar so a draft dir can
 * actually materialize as a `0555` skill projection later (mirror of the
 * sandbox-protocol ID_RE — re-declared locally per invariant I2). A dir whose
 * name can't be a valid skill id is rejected at the chokepoint rather than
 * silently dropped downstream.
 */

// Strict installable-skill id grammar (mirror of @ax/sandbox-protocol's ID_RE
// and @ax/skills' projectable id). Re-declared locally (I2 — no cross-plugin
// import). If that grammar changes, update here.
const SKILL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const PREFIX = '/ephemeral/skill-draft/';

export type DraftPathCheckResult =
  | { ok: true; skillId: string; relativeDir: string }
  | { ok: false; reason: string };

/**
 * Validate a model-supplied draft directory path. On success returns the skill
 * `<id>` (the single path segment under the prefix) and the `relativeDir`
 * (`skill-draft/<id>`) the executor maps under `<ephemeralRoot>`.
 *
 * Rejects: empty paths, anything outside `/ephemeral/skill-draft/`, a bare
 * prefix with no id, any `..` traversal, a nested path (only ONE segment — the
 * id — is allowed; the executor lists the dir's contents itself), and an id that
 * fails the strict grammar.
 */
export function checkDraftPath(absPath: string): DraftPathCheckResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'skill-draft-path-not-allowed: empty path' };
  }
  if (!absPath.startsWith(PREFIX)) {
    return {
      ok: false,
      reason: `skill-draft-path-not-allowed: path must be under ${PREFIX}<id>`,
    };
  }
  // Strip the prefix and any single trailing slash (the model may pass the dir
  // with or without it). What remains must be exactly the `<id>` segment.
  let rest = absPath.slice(PREFIX.length);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  if (rest.length === 0) {
    return { ok: false, reason: 'skill-draft-path-not-allowed: no skill id component' };
  }
  if (rest.includes('/')) {
    return {
      ok: false,
      reason: `skill-draft-path-not-allowed: pass the draft DIRECTORY ${PREFIX}<id>, not a nested path`,
    };
  }
  if (rest === '..' || !SKILL_ID_RE.test(rest)) {
    return {
      ok: false,
      reason:
        'skill-draft-path-not-allowed: <id> must be a valid skill id (lowercase letter, then letters/digits/hyphens, <=64 chars)',
    };
  }
  return { ok: true, skillId: rest, relativeDir: `skill-draft/${rest}` };
}
