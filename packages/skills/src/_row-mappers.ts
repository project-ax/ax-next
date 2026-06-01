/**
 * Shared row-to-domain mappers for @ax/skills.
 *
 * Both `store.ts` (global skills_v1_skills) and `user-store.ts`
 * (user-private skills_v1_user_skills) use the same manifest parsing
 * and row mapping logic. Extracting it here avoids duplication while
 * keeping both stores independent (Invariant I4 — one source of truth
 * per concept; the mapper IS the source of truth for the shape).
 *
 * DO NOT import this file from outside the @ax/skills package.
 */
import { parseSkillManifest } from './manifest.js';
import type {
  BundleFile,
  ResolvedSkill,
  SkillDetail,
  SkillSummary,
} from './types.js';

/**
 * Derive the skill's connector-id reference list from its manifest YAML
 * (connectors-first-class design). The manifest YAML is the single source of
 * truth, re-parsed on read — there is no stored `connectors` column. A corrupt
 * manifest degrades to `[]` (logged once so a bad row never breaks list/resolve).
 * A manifest with no `connectors:` parses to `[]`.
 *
 * TASK-100 — this is the ONLY reach a skill declares now (the capability block
 * was removed): the connectors a skill names are resolved into sandbox caps by
 * the orchestrator (the skill→connector bridge). The manifest YAML stays the
 * single source of truth, re-parsed on read (no stored column).
 */
export function parseConnectors(
  manifestYaml: string,
  skillId: string,
): string[] {
  const result = parseSkillManifest(manifestYaml);
  if (!result.ok) {
    process.stderr.write(
      `[@ax/skills/store] corrupt_manifest skillId=${JSON.stringify(skillId)} code=${result.code} message=${JSON.stringify(result.message)}\n`,
    );
    return [];
  }
  return result.value.connectors;
}

// ---------------------------------------------------------------------------
// Row shapes (minimal — only the columns both stores share)
// ---------------------------------------------------------------------------
export interface BaseSkillRow {
  skill_id: string;
  description: string;
  manifest_yaml: string;
  body_md: string;
  version: number;
  default_attached: boolean;
  source_url: string | null;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Global mappers — scope is always 'global'
// ---------------------------------------------------------------------------

export function rowToGlobalSummary(row: BaseSkillRow): SkillSummary {
  return {
    id: row.skill_id,
    description: row.description,
    version: row.version,
    connectors: parseConnectors(row.manifest_yaml, row.skill_id),
    defaultAttached: row.default_attached,
    ...(row.source_url !== null ? { sourceUrl: row.source_url } : {}),
    updatedAt: row.updated_at.toISOString(),
    scope: 'global',
  };
}

export function rowToGlobalDetail(
  row: BaseSkillRow,
  files: BundleFile[] = [],
): SkillDetail {
  return {
    ...rowToGlobalSummary(row),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
    files,
  };
}

export function rowToGlobalResolved(
  row: BaseSkillRow,
  files: BundleFile[] = [],
): ResolvedSkill {
  return {
    id: row.skill_id,
    connectors: parseConnectors(row.manifest_yaml, row.skill_id),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
    files,
  };
}

// ---------------------------------------------------------------------------
// User-scoped mappers — scope is always 'user', ownerUserId is always set
// ---------------------------------------------------------------------------

export function rowToUserSummary(
  row: BaseSkillRow,
  ownerUserId: string,
): SkillSummary {
  return {
    id: row.skill_id,
    description: row.description,
    version: row.version,
    connectors: parseConnectors(row.manifest_yaml, row.skill_id),
    defaultAttached: row.default_attached,
    ...(row.source_url !== null ? { sourceUrl: row.source_url } : {}),
    updatedAt: row.updated_at.toISOString(),
    scope: 'user',
    ownerUserId,
  };
}

export function rowToUserDetail(
  row: BaseSkillRow,
  ownerUserId: string,
  files: BundleFile[] = [],
): SkillDetail {
  return {
    ...rowToUserSummary(row, ownerUserId),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
    files,
  };
}

export function rowToUserResolved(
  row: BaseSkillRow,
  files: BundleFile[] = [],
): ResolvedSkill {
  return {
    id: row.skill_id,
    connectors: parseConnectors(row.manifest_yaml, row.skill_id),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
    files,
  };
}
