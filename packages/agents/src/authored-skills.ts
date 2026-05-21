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

  let paths: string[];
  try {
    const r = await bus.call<{ pathGlob: string }, { paths: string[] }>(
      'workspace:list',
      ctx,
      { pathGlob: '.ax/skills/*/SKILL.md' },
    );
    paths = r.paths;
  } catch {
    // Workspace unreachable / empty -> non-fatal, return nothing.
    return [];
  }

  const out: AuthoredSkillSummary[] = [];
  for (const path of paths) {
    // Extract the skill id from the path segment between `.ax/skills/` and
    // `/SKILL.md`. The glob guarantees the pattern matches, but we re-check
    // defensively so a corrupt workspace entry doesn't crash the loop.
    const idMatch = /^\.ax\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (idMatch === null) continue;
    const id = idMatch[1]!;

    let read: { found: true; bytes: Uint8Array } | { found: false };
    try {
      read = await bus.call<
        { path: string },
        { found: true; bytes: Uint8Array } | { found: false }
      >('workspace:read', ctx, { path });
    } catch {
      continue;
    }
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
      capabilities.mcpServers.length > 0;

    out.push({ id, description, version, bodyMd: split.bodyMd, hasForbiddenCapabilities });
  }

  // Sort by id so callers get a deterministic order regardless of workspace
  // iteration order.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return out;
}
