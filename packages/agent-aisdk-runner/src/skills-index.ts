// ---------------------------------------------------------------------------
// Skill discovery — the last mile the Anthropic SDK used to do for us.
//
// Everything UPSTREAM of this file already works and is runner-agnostic:
// `materializeInstalledSkillsFromEnv` (k8s, `@ax/agent-runner-core`) and
// sandbox-subprocess's `open-session` (subprocess) both write each installed
// skill bundle to `$CLAUDE_CONFIG_DIR/skills/<id>/`, re-validate every path at
// the extract boundary, chmod files to 0444 and the tree to 0555, and — when
// the skill's connectors resolved to MCP servers — drop a `.mcp.json` next to
// `SKILL.md`.
//
// Only the last mile was SDK-specific: `settingSources: ['user']` (discovery)
// and the built-in `Skill` tool (progressive load). `ai@7` has neither, so this
// module is the discovery half and `tools/skill-tool.ts` is the load half.
//
// WHY WE WALK A DIRECTORY, NOT `AX_INSTALLED_SKILLS_JSON`
// The env var is only the k8s transport. The subprocess sandbox writes the same
// tree directly and never sets it. The projection on disk is what both paths
// agree on, so the projection is what we read.
//
// I₃ — SECURITY, the constraint that outranks everything else here:
// `$CLAUDE_CONFIG_DIR/skills/` is the SOLE discovery path. We never read
// `.claude/skills/` from the workspace. That directory is AGENT-WRITABLE and
// pass-through in `@ax/validator-skill` — reading it would let an agent write
// `.claude/skills/evil/SKILL.md` and have it discovered, walking straight past
// the host projection, the quarantine scan, and the `approved_caps`
// intersection. It is exactly why the claude-sdk runner dropped `'project'`
// from `settingSources` in Phase 3, and this runner must not reintroduce the
// hole by another door. `skills-index.test.ts` plants a decoy there and asserts
// it never appears.
// ---------------------------------------------------------------------------

import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { parseSkillManifest, splitSkillMd } from '@ax/skills-parser';
import type { ParsedManifest } from '@ax/skills-parser';

export interface DiscoveredSkill {
  /** The directory name under `skills/` — the installed skill's id. */
  id: string;
  /** `name:` from the manifest. Usually equal to `id`, but not guaranteed. */
  name: string;
  /** `description:` from the manifest. Always ≤ 240 chars (parser-enforced). */
  description: string;
  /** Absolute path to the bundle dir, so the model can Read/Bash inside it. */
  dir: string;
  /** The SKILL.md body, frontmatter stripped. Loaded on demand, not at boot. */
  body: string;
  /** True when this skill's MCP servers were materialized but cannot be run. */
  hasMcpServers: boolean;
}

export interface DiscoverInstalledSkillsOptions {
  /** Defaults to `$CLAUDE_CONFIG_DIR`. Tests pass a tmpdir. */
  configDir?: string;
}

/** The one file every bundle must have. Its absence means "not a skill dir". */
const SKILL_MANIFEST_FILE = 'SKILL.md';

/**
 * The Anthropic-SDK-shaped MCP config `materializeInstalledSkillsFromEnv`
 * writes when a skill's connectors resolved to servers. On this runner it is a
 * TOMBSTONE, not a config: nothing reads it, and its presence is how we know to
 * warn (see {@link DiscoveredSkill.hasMcpServers}).
 */
const MCP_CONFIG_FILE = '.mcp.json';

function log(line: string): void {
  process.stderr.write(`aisdk-runner: skills: ${line}\n`);
}

/**
 * Does the parsed manifest itself declare MCP servers?
 *
 * Today this can never be true: since TASK-100 a skill manifest carries NO
 * capability block at all, and `parseSkillManifest` HARD-REJECTS a top-level
 * `mcpServers:` / `capabilities:` with `capability-block-forbidden` — such a
 * SKILL.md fails to parse and is skipped (loudly) before it reaches here. Reach
 * lives on connectors now, and the host resolves those into the materialized
 * `.mcp.json`, which is why that file is the real signal.
 *
 * The check stays because it is one cheap line standing between us and a silent
 * regression: if the parser ever relaxes and starts surfacing `mcpServers`
 * through `extra`, a skill would otherwise load with `hasMcpServers: false` and
 * the model would be told nothing while its tools quietly failed to exist.
 * Exported so the unit test can drive it directly rather than pretending the
 * unreachable path is covered.
 */
export function manifestDeclaresMcpServers(manifest: ParsedManifest): boolean {
  const declared = manifest.extra['mcpServers'];
  return Array.isArray(declared) ? declared.length > 0 : declared !== undefined;
}

/**
 * Walk `$CLAUDE_CONFIG_DIR/skills/` and parse each bundle's `SKILL.md`.
 *
 * NEVER THROWS. Skill discovery is a nice-to-have at boot; a malformed bundle,
 * an unreadable file, or a missing projection must degrade the session, not
 * abort it. Every skipped skill is logged with its id and the reason.
 */
export async function discoverInstalledSkills(
  opts: DiscoverInstalledSkillsOptions = {},
): Promise<DiscoveredSkill[]> {
  const configDir = opts.configDir ?? process.env['CLAUDE_CONFIG_DIR'] ?? '';
  if (configDir.length === 0) return [];

  const skillsDir = path.join(configDir, 'skills');

  let entries: Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    // A missing projection is the NORMAL case for a session with no installed
    // skills — the sandbox init container may never create `skills/`. Only a
    // non-ENOENT failure is worth a line of noise.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`could not read ${skillsDir}: ${errText(err)}`);
    }
    return [];
  }

  const out: DiscoveredSkill[] = [];
  // Sorted so the prompt index (and therefore the prompt cache prefix) is
  // stable across boots — readdir order is filesystem-dependent.
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // Only real directories. A symlink is not a materialized bundle, and
    // following one would let anything able to create a link inside `skills/`
    // redirect discovery outside the 0555 projection — the same class of
    // bypass I₃ exists to prevent. `withFileTypes` does not follow links, so
    // `isDirectory()` is already false for a symlinked dir.
    if (!entry.isDirectory()) continue;

    const skill = await loadSkill(skillsDir, entry.name);
    if (skill !== undefined) out.push(skill);
  }

  return out;
}

async function loadSkill(
  skillsDir: string,
  id: string,
): Promise<DiscoveredSkill | undefined> {
  const dir = path.join(skillsDir, id);

  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, SKILL_MANIFEST_FILE), 'utf8');
  } catch (err) {
    log(`skipping '${id}': cannot read ${SKILL_MANIFEST_FILE} (${errText(err)})`);
    return undefined;
  }

  const split = splitSkillMd(raw);
  if (split === null) {
    log(`skipping '${id}': ${SKILL_MANIFEST_FILE} has no --- frontmatter fence`);
    return undefined;
  }

  const parsed = parseSkillManifest(split.manifestYaml);
  if (!parsed.ok) {
    // The parse CODE is the payload here. Repo history: an
    // "authored-skill-not-found" symptom turned out to be an *invalid*
    // SKILL.md (a description over 240 chars, or a non-slug name), not a
    // missing file — and the silence around it cost real debugging time. Say
    // which skill and say which rule it broke.
    log(
      `skipping '${id}': invalid ${SKILL_MANIFEST_FILE} [${parsed.code}] ${parsed.message}`,
    );
    return undefined;
  }

  const hasMcpServers =
    (await fileExists(path.join(dir, MCP_CONFIG_FILE))) ||
    manifestDeclaresMcpServers(parsed.value);

  if (hasMcpServers) {
    // Logged ONCE here, at discovery, and repeated to the model in the `Skill`
    // response (design §3: "degradation must be visible, not silent"). The
    // operator sees it in the runner log; the model sees it at the moment it
    // matters. Neither audience has to infer it from tools that never appear.
    log(
      `'${id}' declares MCP servers; this runner has no MCP client, so its ` +
        'server-provided tools will not exist (design §3 — not supported, by decision)',
    );
  }

  return {
    id,
    name: parsed.value.id,
    description: parsed.value.description,
    dir,
    body: split.bodyMd,
    hasMcpServers,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * The compact index appended to the composed system prompt.
 *
 * PROGRESSIVE DISCLOSURE — the whole design in one function: descriptions are
 * always present (cheap, ≤ 240 chars each), bodies are on demand via the
 * `Skill` tool. Putting bodies here would blow the prompt budget on skills the
 * turn never uses, which is precisely what the SDK's own `Skill` tool avoids.
 *
 * Returns `''` for an empty list — a header with nothing under it reads to the
 * model as "skills exist but are broken", which is worse than silence.
 */
export function buildSkillsPromptSection(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return '';

  const lines = skills.map((s) => `- ${s.name} — ${s.description}`);
  return [
    '## Available skills',
    '',
    ...lines,
    '',
    `Each line above is a summary. To load a skill's full instructions, call the \`Skill\` tool with that skill's name (for example: \`Skill({"name": "${skills[0]?.name ?? ''}"})\`). Do this before following a skill, not after.`,
  ].join('\n');
}
