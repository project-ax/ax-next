/**
 * `skill_propose` draft-dir path allowlist (TASK-74, out-of-git Part D / §D1;
 * filestore-user-files Phase 3 / TASK-165).
 *
 * Pure-function path validation. No filesystem access. Reused by the runner-side
 * executor (for actual enforcement) and available to the host descriptor for the
 * model-facing `description`.
 *
 * Skill authoring is confined to `<root>/.skill-draft/<id>/`, where `<root>` is the
 * agent's DURABLE per-agent user-files mount when one is wired (`AX_USERFILES_ROOT`,
 * e.g. `/workspace`) and the ephemeral scratch tier otherwise (graceful fallback).
 * On the durable mount a half-finished draft now PERSISTS across sessions (design
 * §7 / D8) instead of evaporating with the per-pod emptyDir. The model passes the
 * draft DIRECTORY (not a file); the executor then reads `SKILL.md` + extra files
 * from it. The active `<root>` is dynamic per deployment, so the prefix is computed
 * from it rather than hard-coded — the model is told the live prefix in the
 * `skill_propose` descriptor + the skill-authoring system-prompt note.
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

// Dotted scratch subdir under the active root. Dotted so it reads as agent-
// internal scaffolding (and, on the durable `/workspace` mount, isn't mistaken
// for a user file). The subdir name is fixed; only the parent `<root>` varies.
const DRAFT_SUBDIR = '.skill-draft';

/**
 * The model-facing draft-dir prefix for a given active root: `<root>/.skill-draft/`.
 * A trailing slash on `root` is normalized away so `draftPrefix('/workspace/')`
 * and `draftPrefix('/workspace')` agree. Used by `checkDraftPath` and surfaced to
 * the model in the descriptor + system-prompt note.
 */
export function draftPrefix(root: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${base}/${DRAFT_SUBDIR}/`;
}

export type DraftPathCheckResult =
  | { ok: true; skillId: string; relativeDir: string }
  | { ok: false; reason: string };

/**
 * Validate a model-supplied draft directory path against the ACTIVE draft `root`
 * (the executor passes the same root it will read from — durable `AX_USERFILES_ROOT`
 * when wired, else the ephemeral scratch root). On success returns the skill `<id>`
 * (the single path segment under the prefix) and the `relativeDir`
 * (`.skill-draft/<id>`) the executor maps under `<root>`.
 *
 * Rejects: empty paths, anything outside `<root>/.skill-draft/` (including a draft
 * path rooted at a DIFFERENT tier — the executor only reads from `root`), a bare
 * prefix with no id, any `..` traversal, a nested path (only ONE segment — the id —
 * is allowed; the executor lists the dir's contents itself), and an id that fails
 * the strict grammar.
 */
export function checkDraftPath(absPath: string, root: string): DraftPathCheckResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'skill-draft-path-not-allowed: empty path' };
  }
  const prefix = draftPrefix(root);
  if (!absPath.startsWith(prefix)) {
    return {
      ok: false,
      reason: `skill-draft-path-not-allowed: path must be under ${prefix}<id>`,
    };
  }
  // Strip the prefix and any single trailing slash (the model may pass the dir
  // with or without it). What remains must be exactly the `<id>` segment.
  let rest = absPath.slice(prefix.length);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  if (rest.length === 0) {
    return { ok: false, reason: 'skill-draft-path-not-allowed: no skill id component' };
  }
  if (rest.includes('/')) {
    return {
      ok: false,
      reason: `skill-draft-path-not-allowed: pass the draft DIRECTORY ${prefix}<id>, not a nested path`,
    };
  }
  if (rest === '..' || !SKILL_ID_RE.test(rest)) {
    return {
      ok: false,
      reason:
        'skill-draft-path-not-allowed: <id> must be a valid skill id (lowercase letter, then letters/digits/hyphens, <=64 chars)',
    };
  }
  return { ok: true, skillId: rest, relativeDir: `${DRAFT_SUBDIR}/${rest}` };
}
