export type {
  CapabilitySlot,
  SkillCapabilities,
  SkillSummary,
  SkillDetail,
  ResolvedSkill,
  SkillsListInput,
  SkillsListOutput,
  SkillsGetInput,
  SkillsGetOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
  SkillsDeleteInput,
  SkillsDeleteOutput,
  SkillsResolveInput,
  SkillsResolveOutput,
  SkillsListDefaultsInput,
  SkillsListDefaultsOutput,
} from './types.js';

export { parseSkillManifest } from './manifest.js';
export type { ManifestCode, ParsedManifest, ParseResult } from './manifest.js';

export { createSkillsPlugin } from './plugin.js';
