/**
 * @ax/skills public hook payload types.
 *
 * Inter-plugin API. A future @ax/skills-fs (file-backed impl) would
 * register the same `skills:*` service hooks with these exact shapes —
 * no field here mentions postgres, rows, or any storage detail.
 */

import type { SkillCapabilities } from '@ax/skills-parser';
export type { CapabilitySlot, McpServerSpec, SkillCapabilities } from '@ax/skills-parser';

export interface SkillSummary {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
  defaultAttached: boolean;
  sourceUrl?: string;
  updatedAt: string;
  /** Storage scope for this skill. 'global' = admin-managed; 'user' = user-private copy. */
  scope: 'global' | 'user';
  /** Present iff scope === 'user'. The user who owns this private skill copy. */
  ownerUserId?: string;
}

export interface SkillDetail extends SkillSummary {
  bodyMd: string;
  manifestYaml: string;
}

export interface ResolvedSkill {
  id: string;
  capabilities: SkillCapabilities;
  bodyMd: string;
  manifestYaml: string;
}

export interface SkillsListInput {
  /** 'all' (default) = global + user rows unioned; 'global' = admin rows only; 'user' = user rows only. */
  scope?: 'all' | 'global' | 'user';
  /** Required when scope === 'user' or scope === 'all' to include user rows. */
  ownerUserId?: string;
}
export interface SkillsListOutput {
  skills: SkillSummary[];
}

export interface SkillsGetInput {
  skillId: string;
  /** If omitted or 'all': user row wins over global when ownerUserId is provided. */
  scope?: 'all' | 'global' | 'user';
  ownerUserId?: string;
}
export type SkillsGetOutput = SkillDetail;

export interface SkillsUpsertInput {
  manifestYaml: string;
  bodyMd: string;
  defaultAttached?: boolean;
  /** 'global' (default) = admin-managed table; 'user' = user-private table. */
  scope?: 'global' | 'user';
  /** Required when scope === 'user'. */
  ownerUserId?: string;
}
export interface SkillsUpsertOutput {
  skillId: string;
  created: boolean;
}

export interface SkillsDeleteInput {
  skillId: string;
  /** 'global' (default) = admin-managed table; 'user' = user-private table. */
  scope?: 'global' | 'user';
  /** Required when scope === 'user'. */
  ownerUserId?: string;
}
export type SkillsDeleteOutput = Record<string, never>;

export interface SkillsResolveInput {
  skillIds: string[];
  /** When provided, user-scoped skills are resolved and override same-id globals. */
  ownerUserId?: string;
}
export interface SkillsResolveOutput {
  skills: ResolvedSkill[];
}

export interface SkillsListDefaultsInput {
  /** When provided, user-scoped default skills are unioned with globals (user wins on collision). */
  ownerUserId?: string;
}
export interface SkillsListDefaultsOutput {
  skills: ResolvedSkill[];
}

// Phase C — version-aware refresh hook surface. Storage-agnostic and
// alternate-impl-friendly: a future "skill registry index" plugin can
// implement this same hook against an internal catalog instead of the
// fetch-based logic in @ax/skills/check-updates.ts. See the locked
// boundary review in docs/plans/2026-05-20-skills-versioning-design-note.md
// (C-design.3) for details.
export interface SkillsCheckForUpdatesInput {
  skillId: string;
}
export interface SkillsCheckForUpdatesOutput {
  available: boolean;        // false if sourceUrl unset OR latestVersion <= currentVersion
  currentVersion: number;
  latestVersion?: number;    // when sourceUrl is set, the version we successfully fetched
  latestSkillMd?: string;    // present iff available === true (the freshly-fetched body)
}
