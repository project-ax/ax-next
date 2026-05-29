import { makeAgentContext, PluginError, type HookBus } from '@ax/core';
import { parseSkillManifest, splitSkillMd } from '@ax/skills-parser';
import type { AuthoredSkillSummary } from './types.js';

const PLUGIN_NAME = '@ax/agents';

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
 * `.ax/draft-skills/<id>.md` (see readAuthoredBundle). Returns a summary for each
 * parseable entry, sorted by id for determinism; the directory form wins on a
 * duplicate id.
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
  // Two on-disk shapes (mirrors readAuthoredBundle): the canonical directory
  // form `.ax/draft-skills/<id>/SKILL.md` and the flat form `.ax/draft-skills/<id>.md` that
  // an agent often writes by mistake. List both so the promote flow sees every
  // authored skill regardless of shape. (`*` never crosses `/` in the glob, so
  // the flat glob matches only top-level `.ax/draft-skills/<id>.md`.)
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

/**
 * Best-effort hint for the `authored-skill-not-found` message: when neither
 * accepted shape exists, scan `.ax/draft-skills/` for files whose path mentions the
 * skill id (a wrong-case directory, a typo'd id) and name a few back to the
 * agent so it can fix the path rather than re-deriving blind. Never throws —
 * an outage here must not mask the real not-found — and returns '' when there's
 * nothing useful to add. The id is already trust-validated by the caller.
 */
export async function describeNearbyAuthoredSkills(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
  skillId: string,
): Promise<string> {
  if (!bus.hasService('workspace:list')) return '';
  const ctx = makeAgentContext({
    userId: ownerUserId,
    agentId,
    sessionId: 'authored-skills-nearby',
  });
  let paths: string[];
  try {
    const r = await bus.call<{ pathGlob: string }, { paths: string[] }>(
      'workspace:list',
      ctx,
      { pathGlob: '.ax/draft-skills/**' },
    );
    paths = r.paths;
  } catch {
    return '';
  }
  const lc = skillId.toLowerCase();
  const near = paths.filter((p) => p.toLowerCase().includes(lc)).slice(0, 5);
  if (near.length === 0) return '';
  return ` I did find these related files in your workspace: ${near.join(', ')} — check the path and filename.`;
}

/** An extra (non-SKILL.md) bundle file, path relative to the skill dir. */
export interface AuthoredBundleFile {
  path: string;
  contents: string;
}

/** A full agent-authored bundle read from `.ax/draft-skills/<id>/`. */
export interface AuthoredBundle {
  id: string;
  description: string;
  version: number;
  bodyMd: string;
  files: AuthoredBundleFile[];
  /**
   * The workspace version (opaque token) the bundle was read from, when the
   * backend reports one. The retire step passes it back as `parent` on the
   * subsequent `workspace:apply` to satisfy the backend's optimistic-
   * concurrency CAS (the mock + git backends both reject a stale parent).
   * `null` when the backend doesn't populate a version.
   */
  bundleVersion: string | null;
  /**
   * The exact workspace paths that make up this draft, so the caller retires
   * precisely what was read. Directory form: every file under
   * `.ax/draft-skills/<id>/` (SKILL.md + helpers). Flat form: the single
   * `.ax/draft-skills/<id>.md`. Carried on the bundle (rather than re-globbed at
   * retire time) so the retire deletes the SAME shape that was promoted —
   * crucial now that two on-disk shapes are accepted.
   */
  draftPaths: string[];
}

// Re-validated at this trust boundary (I2/I5) — never interpolate an
// unvalidated id into a workspace glob. Mirrors @ax/skill-broker's SKILL_ID_RE.
const AUTHORED_SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Parse a SKILL.md's raw content into manifest fields, THROWING
 * `authored-skill-invalid` (with the specific reason) when the frontmatter is
 * missing or rejected — so the agent learns exactly what to fix instead of the
 * misleading "not found". Shared by both on-disk shapes (directory + flat
 * file); `location` is the human-readable path quoted back in the message.
 */
function parseAuthoredManifestOrThrow(
  content: string,
  skillId: string,
  location: string,
): { description: string; version: number; bodyMd: string } {
  const split = splitSkillMd(content);
  if (split === null) {
    throw new PluginError({
      code: 'authored-skill-invalid',
      plugin: PLUGIN_NAME,
      message:
        `the authored skill '${skillId}' at ${location} is missing its YAML frontmatter — ` +
        `it must start with a '---' fenced block declaring at least name and description. ` +
        `Fix the file and call install_authored_skill again.`,
    });
  }
  const parsed = parseSkillManifest(split.manifestYaml);
  if (!parsed.ok) {
    throw new PluginError({
      code: 'authored-skill-invalid',
      plugin: PLUGIN_NAME,
      message:
        `the authored skill '${skillId}' at ${location} has invalid frontmatter: ${parsed.message}. ` +
        `Fix the file and call install_authored_skill again.`,
    });
  }
  return {
    description: parsed.value.description,
    version: parsed.value.version,
    bodyMd: split.bodyMd,
  };
}

/**
 * Read the FULL agent-authored bundle (SKILL.md → manifest+body, plus every
 * helper file) under `.ax/draft-skills/<skillId>/`.
 *
 * Two on-disk shapes are accepted, because agents frequently author a skill as
 * a single flat file instead of a directory:
 *   - DIRECTORY form (canonical): `.ax/draft-skills/<id>/SKILL.md` (+ helper files).
 *   - FLAT form (fallback): `.ax/draft-skills/<id>.md` — read as the SKILL.md with no
 *     helper files. Tried only when the directory form has no SKILL.md.
 * Without the flat fallback, an agent that wrote `.ax/draft-skills/linear.md` got the
 * misleading `authored-skill-not-found` ("no authored skill 'linear' in the
 * workspace") — the dir glob `.ax/draft-skills/linear/**` can't match the flat
 * sibling — and dead-ended, re-writing the same flat file with no idea why.
 *
 * Returns null ONLY when NEITHER shape exists — the caller surfaces a friendly
 * "author it first" message (sharpened there with any near-miss paths). When a
 * SKILL.md (either shape) IS present but invalid (no frontmatter fence, or
 * `parseSkillManifest` rejects it — e.g. description > 240 chars, name not a
 * slug), we THROW `authored-skill-invalid` carrying the specific reason.
 * Conflating the two as null made the handler report the misleading
 * `authored-skill-not-found`, so the agent kept rewriting the same broken file
 * with no idea what was wrong (BUG-W2 follow-up). `mapPluginError` surfaces the
 * message so the agent can fix it and retry.
 *
 * Same ctx routing as listAuthoredSkills: workspace:list/read key off
 * ctx.userId + ctx.agentId (hashed to a workspace shard), so we root a fresh
 * ctx in the agent OWNER's identity to read THAT agent's workspace.
 *
 * SKILL.md is excluded from `files[]` (it becomes `description`/`version`/
 * `bodyMd`); helper files are returned sorted by path for determinism. The
 * exact paths read are returned as `draftPaths` so the caller retires the same
 * shape it promoted.
 */
export async function readAuthoredBundle(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
  skillId: string,
): Promise<AuthoredBundle | null> {
  if (!AUTHORED_SKILL_ID_RE.test(skillId)) {
    throw new Error(`invalid authored skill id: ${JSON.stringify(skillId)}`);
  }
  if (!bus.hasService('workspace:list') || !bus.hasService('workspace:read')) {
    return null;
  }
  const ctx = makeAgentContext({
    userId: ownerUserId,
    agentId,
    sessionId: 'authored-bundle-read',
  });
  const dir = `.ax/draft-skills/${skillId}`;
  const { paths } = await bus.call<{ pathGlob: string }, { paths: string[] }>(
    'workspace:list',
    ctx,
    { pathGlob: `${dir}/**` },
  );

  let manifestSeen = false;
  let description = '';
  let version = 1;
  let bodyMd = '';
  let bundleVersion: string | null = null;
  const files: AuthoredBundleFile[] = [];
  const draftPaths: string[] = [];

  // --- Directory form: `.ax/draft-skills/<id>/SKILL.md` (+ helper files). ---
  for (const p of [...paths].sort()) {
    const read = await bus.call<
      { path: string },
      { found: true; bytes: Uint8Array; version?: string } | { found: false }
    >('workspace:read', ctx, { path: p });
    if (!read.found) continue; // deleted between list and read — skip
    if (read.version !== undefined) bundleVersion = read.version;
    const rel = p.slice(dir.length + 1); // strip ".ax/draft-skills/<id>/"
    if (rel.length === 0) continue;
    draftPaths.push(p);

    if (rel === 'SKILL.md') {
      // SKILL.md is PRESENT — from here a failure is "found but invalid", which
      // we surface (not null) so the agent learns the actual reason and fixes it.
      const m = parseAuthoredManifestOrThrow(
        new TextDecoder().decode(read.bytes),
        skillId,
        `${dir}/SKILL.md`,
      );
      manifestSeen = true;
      description = m.description;
      version = m.version;
      bodyMd = m.bodyMd;
    } else {
      files.push({ path: rel, contents: new TextDecoder().decode(read.bytes) });
    }
  }

  if (manifestSeen) {
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { id: skillId, description, version, bodyMd, files, bundleVersion, draftPaths };
  }

  // --- Flat form fallback: `.ax/draft-skills/<id>.md` (a single markdown file the
  //     agent wrote instead of a directory). No helper files. Same found-but-
  //     invalid surfacing as the directory form. `skillId` is validated, so
  //     `${dir}.md` carries no traversal. ---
  const flatPath = `${dir}.md`;
  const flat = await bus.call<
    { path: string },
    { found: true; bytes: Uint8Array; version?: string } | { found: false }
  >('workspace:read', ctx, { path: flatPath });
  if (flat.found) {
    const m = parseAuthoredManifestOrThrow(
      new TextDecoder().decode(flat.bytes),
      skillId,
      flatPath,
    );
    return {
      id: skillId,
      description: m.description,
      version: m.version,
      bodyMd: m.bodyMd,
      files: [],
      bundleVersion: flat.version ?? null,
      draftPaths: [flatPath],
    };
  }

  return null; // neither the directory nor the flat form exists
}
