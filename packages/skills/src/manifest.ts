// Pure SKILL.md (de)serialization re-exported on the browser-safe subpath:
// parse + build are the single round-trip authority the form-first skill editor
// (TASK-133) leans on, `splitSkillMd` slices the frontmatter fence so the editor
// doesn't re-implement the regex.
export { parseSkillManifest, buildSkillManifestYaml, splitSkillMd } from '@ax/skills-parser';
export type { ManifestCode, ParsedManifest, ParseResult } from '@ax/skills-parser';
