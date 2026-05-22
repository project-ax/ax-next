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
  ResolvedSkill,
  SkillCapabilities,
  SkillDetail,
  SkillSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared capability-parse fallback (copied by value from store.ts)
// ---------------------------------------------------------------------------
export const EMPTY_CAPABILITIES: SkillCapabilities = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

export function parseCapabilities(
  manifestYaml: string,
  skillId: string,
): SkillCapabilities {
  const result = parseSkillManifest(manifestYaml);
  if (!result.ok) {
    process.stderr.write(
      `[@ax/skills/store] corrupt_manifest skillId=${JSON.stringify(skillId)} code=${result.code} message=${JSON.stringify(result.message)}\n`,
    );
    return EMPTY_CAPABILITIES;
  }
  return result.value.capabilities;
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
    capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
    defaultAttached: row.default_attached,
    ...(row.source_url !== null ? { sourceUrl: row.source_url } : {}),
    updatedAt: row.updated_at.toISOString(),
    scope: 'global',
  };
}

export function rowToGlobalDetail(row: BaseSkillRow): SkillDetail {
  return {
    ...rowToGlobalSummary(row),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
  };
}

export function rowToGlobalResolved(row: BaseSkillRow): ResolvedSkill {
  return {
    id: row.skill_id,
    capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
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
    capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
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
): SkillDetail {
  return {
    ...rowToUserSummary(row, ownerUserId),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
  };
}

export function rowToUserResolved(row: BaseSkillRow): ResolvedSkill {
  return {
    id: row.skill_id,
    capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
    bodyMd: row.body_md,
    manifestYaml: row.manifest_yaml,
  };
}
