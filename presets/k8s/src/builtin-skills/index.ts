import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSkillMd, parseSkillManifest } from '@ax/skills-parser';
import type { ResolvedSkillForOrch } from '@ax/chat-orchestrator';

/**
 * System built-in skills shipped with the k8s preset. Materialized into every
 * session (lowest precedence) ONLY when open mode is on — see index.ts. The
 * SKILL.md assets travel inside the compiled package (dist/builtin-skills/...);
 * a parse/read failure here is a build/packaging bug, so we throw at boot.
 */
export function loadBuiltinSkills(): ResolvedSkillForOrch[] {
  return [loadOne('ax-skill-creator'), loadOne('ax-connector-creator')];
}

function loadOne(id: string): ResolvedSkillForOrch {
  const md = readFileSync(
    fileURLToPath(new URL(`./${id}/SKILL.md`, import.meta.url)),
    'utf8',
  );
  const split = splitSkillMd(md);
  if (split === null) throw new Error(`builtin skill ${id}: SKILL.md has no frontmatter fence`);
  const parsed = parseSkillManifest(split.manifestYaml);
  if (!parsed.ok) throw new Error(`builtin skill ${id}: ${parsed.message}`);
  return {
    id: parsed.value.id,
    manifestYaml: split.manifestYaml,
    bodyMd: split.bodyMd,
    files: [],
    capabilities: {
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    },
  };
}
