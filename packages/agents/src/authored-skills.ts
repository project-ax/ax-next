import { type HookBus } from '@ax/core';
import { parseSkillManifest } from '@ax/skills-parser';
import type { AuthoredSkillSummary } from './types.js';

/**
 * Authored-skill readers (TASK-74 re-backing). The source of truth is the
 * @ax/skills DB store (the `skills:list-authored` hook) — the `.ax/draft-skills`
 * git WORKSPACE projection (the old `listAuthoredBundles` + workspace:list/read
 * scan) is RETIRED (one source of truth, invariant I4). Both readers here now
 * read the same DB rows; nothing scans the workspace.
 */

/** One authored skill row, as @ax/skills' skills:list-authored returns it.
 * Re-declared structurally (I2 — no @ax/skills import); the field shape mirrors
 * @ax/skills' AuthoredSkillProjection. */
interface AuthoredRow {
  skillId: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  files: Array<{ path: string; contents: string }>;
  status: 'active' | 'pending' | 'quarantined';
  reason?: string;
}

async function listAuthoredRows(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
): Promise<AuthoredRow[]> {
  // Soft dep — a preset without @ax/skills has no authored skills.
  if (!bus.hasService('skills:list-authored')) return [];
  const { skills } = await bus.call<
    { ownerUserId: string; agentId: string },
    { skills: AuthoredRow[] }
  >('skills:list-authored', undefined as never, { ownerUserId, agentId });
  return skills;
}

/**
 * Parse one authored skill's manifest into a promote-UI summary, or null when
 * it's malformed. Flags any declared capability so the promote UI can say
 * "remove capabilities first" (or, post-gate, surface that it needs approval).
 */
function summarizeAuthoredSkill(
  skillId: string,
  manifestYaml: string,
  bodyMd: string,
): AuthoredSkillSummary | null {
  const parsed = parseSkillManifest(manifestYaml);
  if (!parsed.ok) return null;
  const { capabilities, description, version } = parsed.value;
  const hasForbiddenCapabilities =
    capabilities.allowedHosts.length > 0 ||
    capabilities.credentials.length > 0 ||
    capabilities.mcpServers.length > 0 ||
    (capabilities.packages?.npm.length ?? 0) > 0 ||
    (capabilities.packages?.pypi.length ?? 0) > 0;
  return { id: skillId, description, version, bodyMd, hasForbiddenCapabilities };
}

/**
 * List an agent's authored skills for the human-reviewed promote UI
 * (`agents:list-authored-skills`). Reads the DB store via `skills:list-authored`
 * (TASK-74) — quarantined rows are still surfaced here (the admin needs to see a
 * flagged draft to act on it), unlike the orchestrator projection which omits
 * them. A malformed manifest is silently skipped. Sorted by id for determinism.
 */
export async function listAuthoredSkills(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
): Promise<AuthoredSkillSummary[]> {
  const rows = await listAuthoredRows(bus, ownerUserId, agentId);
  const out: AuthoredSkillSummary[] = [];
  for (const r of rows) {
    const summary = summarizeAuthoredSkill(r.skillId, r.manifestYaml, r.bodyMd);
    if (summary !== null) out.push(summary);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
