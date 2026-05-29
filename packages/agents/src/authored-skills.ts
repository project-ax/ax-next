import { makeAgentContext, type HookBus } from '@ax/core';
import { parseSkillManifest, splitSkillMd } from '@ax/skills-parser';
import type { AuthoredSkillSummary } from './types.js';

/**
 * Parse one authored SKILL.md's raw content into a summary, or null when it's
 * malformed (no frontmatter fence, or `parseSkillManifest` rejects it) — the
 * caller silently skips nulls (the agent fixes the file before promoting).
 * Flags any capability the agent-authored file declares (it shouldn't — caps
 * are stripped at write time) so the promote UI can say "remove capabilities
 * first" rather than silently hiding the skill.
 */
function summarizeAuthoredSkill(id: string, content: string): AuthoredSkillSummary | null {
  const split = splitSkillMd(content);
  if (split === null) return null;
  const parsed = parseSkillManifest(split.manifestYaml);
  if (!parsed.ok) return null;
  const { capabilities, description, version } = parsed.value;
  const hasForbiddenCapabilities =
    capabilities.allowedHosts.length > 0 ||
    capabilities.credentials.length > 0 ||
    capabilities.mcpServers.length > 0 ||
    // packages declares registry egress — treat it the same as allowedHosts.
    // Guard for undefined: older manifest shapes may not include the field.
    (capabilities.packages?.npm.length ?? 0) > 0 ||
    (capabilities.packages?.pypi.length ?? 0) > 0;
  return { id, description, version, bodyMd: split.bodyMd, hasForbiddenCapabilities };
}

/**
 * Scan an agent's workspace for authored skills in either accepted shape — the
 * directory form `.ax/draft-skills/<id>/SKILL.md` and the flat form
 * `.ax/draft-skills/<id>.md`. Returns a summary for each parseable entry, sorted
 * by id for determinism; the directory form wins on a duplicate id.
 *
 * workspace:list / workspace:read are SOFT deps — if neither is loaded (e.g.
 * a stripped preset without a workspace plugin) we return [] rather than
 * throw, matching the "no workspace = no authored skills discoverable"
 * semantic.
 *
 * Agent-authored files MUST NOT declare capabilities (allowedHosts,
 * credentials, mcpServers). We FLAG entries that do instead of dropping them
 * so the UI can show "remove capabilities first" rather than silently hiding
 * the skill from the promote flow.
 *
 * NOTE on ctx routing: workspace hooks key off ctx.userId + ctx.agentId
 * (hashed to a workspace id). We construct a fresh ctx from the agent's
 * actual owner userId so we read THAT agent's workspace, not the caller's.
 */
export async function listAuthoredSkills(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
): Promise<AuthoredSkillSummary[]> {
  // Soft-dep guard — stripped presets omit a workspace backend.
  if (!bus.hasService('workspace:list') || !bus.hasService('workspace:read')) {
    return [];
  }

  // Build a ctx rooted in the agent owner's identity so workspace:list and
  // workspace:read address the right workspace shard. Do NOT reuse the
  // caller's ctx — that would read the wrong workspace (the caller's agent's
  // files, not this agent's files).
  const ctx = makeAgentContext({
    userId: ownerUserId,
    agentId,
    sessionId: 'authored-skills-scan',
  });

  // workspace:list / workspace:read return {paths:[]} / {found:false} for a
  // missing or empty workspace — they do NOT throw for those expected cases.
  // Any exception from here is therefore a genuine backend outage; we let it
  // propagate so the caller (admin route) sees a 500 rather than a misleading
  // empty list.
  // Two on-disk shapes: the canonical directory form
  // `.ax/draft-skills/<id>/SKILL.md` and the flat form `.ax/draft-skills/<id>.md`
  // that an agent often writes by mistake. List both so the promote flow sees
  // every authored skill regardless of shape. (`*` never crosses `/` in the
  // glob, so the flat glob matches only top-level `.ax/draft-skills/<id>.md`.)
  const [dirRes, flatRes] = await Promise.all([
    bus.call<{ pathGlob: string }, { paths: string[] }>('workspace:list', ctx, {
      pathGlob: '.ax/draft-skills/*/SKILL.md',
    }),
    bus.call<{ pathGlob: string }, { paths: string[] }>('workspace:list', ctx, {
      pathGlob: '.ax/draft-skills/*.md',
    }),
  ]);

  // Build the (id, path) read-list. Directory form FIRST so it wins on a
  // duplicate id (an agent that has both `<id>/SKILL.md` and `<id>.md`).
  const entries: Array<{ id: string; path: string }> = [];
  const seen = new Set<string>();
  for (const path of dirRes.paths) {
    // The glob guarantees the pattern, but re-check defensively so a corrupt
    // entry doesn't crash the loop.
    const m = /^\.ax\/draft-skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (m === null) continue;
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, path });
  }
  for (const path of flatRes.paths) {
    const m = /^\.ax\/draft-skills\/([^/]+)\.md$/.exec(path);
    if (m === null) continue;
    const id = m[1]!;
    // The sandbox enforces the strict id grammar; skip a flat file whose
    // basename isn't a valid skill id (an unrelated note) so it can't
    // masquerade as a promotable skill.
    if (!AUTHORED_SKILL_ID_RE.test(id)) continue;
    if (seen.has(id)) continue; // directory form already won
    seen.add(id);
    entries.push({ id, path });
  }

  const out: AuthoredSkillSummary[] = [];
  for (const { id, path } of entries) {
    const read = await bus.call<
      { path: string },
      { found: true; bytes: Uint8Array } | { found: false }
    >('workspace:read', ctx, { path });
    // {found:false} is the normal "deleted between list and read" case — skip.
    if (!read.found) continue;
    const summary = summarizeAuthoredSkill(id, new TextDecoder().decode(read.bytes));
    if (summary !== null) out.push(summary);
  }

  // Sort by id so callers get a deterministic order regardless of workspace
  // iteration order.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return out;
}

/** An extra (non-SKILL.md) bundle file, path relative to the skill dir. */
export interface AuthoredBundleFile {
  path: string;
  contents: string;
}

// Re-validated at this trust boundary (I2/I5) — never interpolate an
// unvalidated id into a workspace glob. Mirrors @ax/skill-broker's SKILL_ID_RE.
const AUTHORED_SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// The sandbox validates installedSkills ids against this strict grammar
// (mirror of @ax/sandbox-protocol's ID_RE — kept local per invariant #2; if
// that grammar changes, update here). A draft dir whose name can't materialize
// is SKIPPED (like a malformed manifest) so one bad id can't fail the whole
// installedSkills batch at sandbox:open-session.
const PROJECTABLE_SKILL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** A self-authored draft in projection shape: raw frontmatter + body + helper files. */
export interface AuthoredProjectionBundle {
  id: string;
  /** The raw YAML frontmatter string (between the `---` fences) — the projection
   * layer stores this verbatim so it can be parsed later without re-reading the
   * workspace. Does NOT include the `---` delimiters themselves. */
  manifestYaml: string;
  bodyMd: string;
  files: AuthoredBundleFile[];
}

/**
 * Read EVERY parseable self-authored draft under `.ax/draft-skills/` as a
 * projection bundle (raw `manifestYaml` + `bodyMd` + helper files). This is the
 * host discovery-projection source: a malformed SKILL.md is SKIPPED (never
 * thrown) so one bad draft can't break discovery for the rest.
 *
 * Surfaces ONLY the directory form `.ax/draft-skills/<id>/SKILL.md`. This is
 * deliberately narrower than `listAuthoredSkills` (the human-reviewed promote
 * reader, which also accepts the flat form): the directory form is the EXACT
 * shape `@ax/validator-skill` scans+quarantines on commit (its `SKILL_PATH` =
 * `/^\.ax\/draft-skills\/([^/]+)\/SKILL\.md$/`). A flat
 * `.ax/draft-skills/<id>.md` is NEVER scanned — so it is intentionally NOT
 * auto-discovered here; projecting it would let an agent write a hostile flat
 * draft that bypasses the quarantine scan and is then SDK-discoverable. The
 * projection's accepted shapes MUST stay a subset of the scanner's scanned
 * shapes (C1).
 *
 * Projected ids are ALSO gated to the strict sandbox installed-skill grammar
 * (PROJECTABLE_SKILL_ID_RE) — a draft dir whose name can't materialize in the
 * sandbox is SKIPPED, not projected, so it can't fail the whole installedSkills
 * batch at sandbox:open-session (I2).
 *
 * Capabilities are NOT parsed here — Phase 3 projects drafts with empty caps;
 * Phase 4 adds the approval gate.
 *
 * Same ctx-routing as listAuthoredSkills: workspace hooks key off ctx.userId +
 * ctx.agentId. We construct a fresh ctx from the agent owner's identity so we
 * read THAT agent's workspace, not the caller's.
 *
 * Soft-dep: if neither `workspace:list` nor `workspace:read` is loaded (e.g.
 * a stripped preset without a workspace plugin) we return [] rather than throw,
 * matching the "no workspace = no authored skills discoverable" semantic.
 */
export async function listAuthoredBundles(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
): Promise<AuthoredProjectionBundle[]> {
  // Soft-dep guard — stripped presets omit a workspace backend.
  if (!bus.hasService('workspace:list') || !bus.hasService('workspace:read')) {
    return [];
  }

  // Root the ctx in the agent owner's identity so workspace:list and
  // workspace:read address the correct workspace shard. Do NOT reuse the
  // caller's ctx (wrong shard).
  const ctx = makeAgentContext({
    userId: ownerUserId,
    agentId,
    sessionId: 'authored-bundles-projection',
  });

  // Discover ids from the DIRECTORY form ONLY. The flat form
  // `.ax/draft-skills/<id>.md` is deliberately NOT globbed: it is never scanned
  // by @ax/validator-skill (SKILL_PATH is dir-form only), so auto-discovering
  // it would bypass the quarantine scan (C1). The single list call is cheap
  // (glob, no content reads).
  const dirRes = await bus.call<{ pathGlob: string }, { paths: string[] }>(
    'workspace:list',
    ctx,
    { pathGlob: '.ax/draft-skills/*/SKILL.md' },
  );

  // Build the id set from the directory form. Gate each id to the STRICT
  // sandbox installed-skill grammar — a dir whose name can't materialize in the
  // sandbox is SKIPPED here (like a malformed manifest below) so it can't fail
  // the whole installedSkills batch at sandbox:open-session (I2).
  const ids = new Set<string>();
  for (const p of dirRes.paths) {
    const m = /^\.ax\/draft-skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m && PROJECTABLE_SKILL_ID_RE.test(m[1]!)) ids.add(m[1]!);
  }

  const out: AuthoredProjectionBundle[] = [];

  for (const id of [...ids].sort()) {
    const dir = `.ax/draft-skills/${id}`;

    // --- Directory form: list every path under `.ax/draft-skills/<id>/`. ---
    const { paths } = await bus.call<{ pathGlob: string }, { paths: string[] }>(
      'workspace:list',
      ctx,
      { pathGlob: `${dir}/**` },
    );

    let manifestYaml: string | null = null;
    let bodyMd = '';
    const files: AuthoredBundleFile[] = [];

    for (const p of [...paths].sort()) {
      const read = await bus.call<
        { path: string },
        { found: true; bytes: Uint8Array } | { found: false }
      >('workspace:read', ctx, { path: p });
      if (!read.found) continue; // deleted between list and read — skip
      const rel = p.slice(dir.length + 1); // strip ".ax/draft-skills/<id>/"
      if (rel.length === 0) continue;
      const text = new TextDecoder().decode(read.bytes);
      if (rel === 'SKILL.md') {
        // Attempt to parse — but NEVER throw. A malformed SKILL.md silently
        // skips this whole id so one bad draft doesn't block the rest.
        const split = splitSkillMd(text);
        if (split === null || !parseSkillManifest(split.manifestYaml).ok) continue;
        manifestYaml = split.manifestYaml;
        bodyMd = split.bodyMd;
      } else {
        files.push({ path: rel, contents: text });
      }
    }

    // Skip this id entirely if we couldn't parse a valid directory-form
    // manifest (the flat form is intentionally not auto-discovered — see the
    // doc comment / C1).
    if (manifestYaml === null) continue;

    // Sort helper files by path for determinism (SKILL.md is excluded from files[]).
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    out.push({ id, manifestYaml, bodyMd, files });
  }

  return out; // already sorted by id (we iterated [...ids].sort())
}
