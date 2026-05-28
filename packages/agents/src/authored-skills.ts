import { makeAgentContext, type HookBus } from '@ax/core';
import { parseSkillManifest, splitSkillMd } from '@ax/skills-parser';
import type { AuthoredSkillSummary } from './types.js';

/**
 * Scan an agent's workspace for authored SKILL.md files under
 * `.ax/skills/<id>/SKILL.md`. Returns a summary for each parseable entry,
 * sorted by id for determinism.
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
  const r = await bus.call<{ pathGlob: string }, { paths: string[] }>(
    'workspace:list',
    ctx,
    { pathGlob: '.ax/skills/*/SKILL.md' },
  );
  const paths = r.paths;

  const out: AuthoredSkillSummary[] = [];
  for (const path of paths) {
    // Extract the skill id from the path segment between `.ax/skills/` and
    // `/SKILL.md`. The glob guarantees the pattern matches, but we re-check
    // defensively so a corrupt workspace entry doesn't crash the loop.
    const idMatch = /^\.ax\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (idMatch === null) continue;
    const id = idMatch[1]!;

    const read = await bus.call<
      { path: string },
      { found: true; bytes: Uint8Array } | { found: false }
    >('workspace:read', ctx, { path });
    // {found:false} is the normal "deleted between list and read" case — skip.
    if (!read.found) continue;

    const content = new TextDecoder().decode(read.bytes);

    // splitSkillMd returns null when there's no frontmatter fence — silently
    // skip (not a SKILL.md that follows the canonical format).
    const split = splitSkillMd(content);
    if (split === null) continue;

    // parseSkillManifest returns { ok: false } for malformed YAML — silently
    // skip (let the agent fix it before promoting).
    const parsed = parseSkillManifest(split.manifestYaml);
    if (!parsed.ok) continue;

    const { capabilities, description, version } = parsed.value;

    // An agent-authored file MUST NOT declare any capability that grants
    // external reach. We flag (but do not drop) files that do — the promote
    // UI shows "remove capabilities first before promoting this skill."
    const hasForbiddenCapabilities =
      capabilities.allowedHosts.length > 0 ||
      capabilities.credentials.length > 0 ||
      capabilities.mcpServers.length > 0 ||
      // packages declares registry egress — treat it the same as allowedHosts.
      // Guard for undefined: older manifest shapes may not include the field.
      (capabilities.packages?.npm.length ?? 0) > 0 ||
      (capabilities.packages?.pypi.length ?? 0) > 0;

    out.push({ id, description, version, bodyMd: split.bodyMd, hasForbiddenCapabilities });
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

/** A full agent-authored bundle read from `.ax/skills/<id>/`. */
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
}

// Re-validated at this trust boundary (I2/I5) — never interpolate an
// unvalidated id into a workspace glob. Mirrors @ax/skill-broker's SKILL_ID_RE.
const AUTHORED_SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// BUG-W2 follow-up: bounded read-retry for the install read. The agent writes
// `.ax/skills/<id>/SKILL.md` and the runner flushes (commit + push) it to the
// host mirror BEFORE this read — but under CONCURRENT installs (the model can
// fire several `install_authored_skill` calls in one turn) these reads race the
// just-pushed commit: the file IS in the workspace, yet a given read's mirror
// view hasn't caught up, so the SKILL.md path is briefly missing from the list.
// We re-issue `workspace:list` (which re-fetches the mirror) a few times before
// concluding the skill isn't authored. On the genuine "not authored" path this
// adds at most (maxAttempts-1)*backoff of latency to an error return — cheap.
const AUTHORED_READ_MAX_LIST_ATTEMPTS = 5;
const AUTHORED_READ_LIST_BACKOFF_MS = 150;

/**
 * Read the FULL agent-authored bundle (SKILL.md → manifest+body, plus every
 * helper file) under `.ax/skills/<skillId>/`. Returns null when there is no
 * canonical SKILL.md (missing / no frontmatter / malformed YAML) — the caller
 * surfaces a friendly "author it first" message rather than throwing.
 *
 * Same ctx routing as listAuthoredSkills: workspace:list/read key off
 * ctx.userId + ctx.agentId (hashed to a workspace shard), so we root a fresh
 * ctx in the agent OWNER's identity to read THAT agent's workspace.
 *
 * SKILL.md is excluded from `files[]` (it becomes `description`/`version`/
 * `bodyMd`); helper files are returned sorted by path for determinism.
 */
export async function readAuthoredBundle(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
  skillId: string,
  opts: { maxListAttempts?: number; listBackoffMs?: number } = {},
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
  const dir = `.ax/skills/${skillId}`;
  const skillMdPath = `${dir}/SKILL.md`;
  const maxAttempts = opts.maxListAttempts ?? AUTHORED_READ_MAX_LIST_ATTEMPTS;
  const backoffMs = opts.listBackoffMs ?? AUTHORED_READ_LIST_BACKOFF_MS;

  // Re-list until the canonical SKILL.md path shows up (or attempts run out).
  // The presence of `${dir}/SKILL.md` is the authoritative "the flush landed"
  // signal; once it's in the listing the per-path reads below hit the same
  // (now-current) mirror snapshot. See AUTHORED_READ_* above for the race.
  let paths: string[] = [];
  for (let attempt = 0; ; attempt++) {
    ({ paths } = await bus.call<{ pathGlob: string }, { paths: string[] }>(
      'workspace:list',
      ctx,
      { pathGlob: `${dir}/**` },
    ));
    if (paths.includes(skillMdPath) || attempt >= maxAttempts - 1) break;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  let manifestSeen = false;
  let description = '';
  let version = 1;
  let bodyMd = '';
  let bundleVersion: string | null = null;
  const files: AuthoredBundleFile[] = [];

  for (const p of [...paths].sort()) {
    const read = await bus.call<
      { path: string },
      { found: true; bytes: Uint8Array; version?: string } | { found: false }
    >('workspace:read', ctx, { path: p });
    if (!read.found) continue; // deleted between list and read — skip
    if (read.version !== undefined) bundleVersion = read.version;
    const rel = p.slice(dir.length + 1); // strip ".ax/skills/<id>/"
    if (rel.length === 0) continue;

    if (rel === 'SKILL.md') {
      const content = new TextDecoder().decode(read.bytes);
      const split = splitSkillMd(content);
      if (split === null) return null; // not a canonical SKILL.md
      const parsed = parseSkillManifest(split.manifestYaml);
      if (!parsed.ok) return null; // malformed — let the agent fix it
      manifestSeen = true;
      description = parsed.value.description;
      version = parsed.value.version;
      bodyMd = split.bodyMd;
    } else {
      files.push({ path: rel, contents: new TextDecoder().decode(read.bytes) });
    }
  }

  if (!manifestSeen) return null; // no SKILL.md → not an authored skill
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { id: skillId, description, version, bodyMd, files, bundleVersion };
}
