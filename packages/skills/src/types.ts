/**
 * @ax/skills public hook payload types.
 *
 * Inter-plugin API. A future @ax/skills-fs (file-backed impl) would
 * register the same `skills:*` service hooks with these exact shapes —
 * no field here mentions postgres, rows, or any storage detail.
 */

export interface CapabilitySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
}

export interface SkillCapabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
}

export interface SkillSummary {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
  updatedAt: string;
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

export type SkillsListInput = Record<string, never>;
export interface SkillsListOutput {
  skills: SkillSummary[];
}

export interface SkillsGetInput {
  skillId: string;
}
export type SkillsGetOutput = SkillDetail;

export interface SkillsUpsertInput {
  manifestYaml: string;
  bodyMd: string;
}
export interface SkillsUpsertOutput {
  skillId: string;
  created: boolean;
}

export interface SkillsDeleteInput {
  skillId: string;
}
export type SkillsDeleteOutput = Record<string, never>;

export interface SkillsResolveInput {
  skillIds: string[];
}
export interface SkillsResolveOutput {
  skills: ResolvedSkill[];
}
