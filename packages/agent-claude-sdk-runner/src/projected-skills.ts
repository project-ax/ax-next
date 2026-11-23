// ---------------------------------------------------------------------------
// Only AX's own skills can be invoked (TASK-1207).
//
// The `Skill` tool is on the `tools` allowlist (I-P0-1): it is how the model
// opens a skill AX installed under $CLAUDE_CONFIG_DIR/skills/, the read-only
// projection both sandbox providers write before the runner starts (k8s:
// runner-core's materializer, from AX_INSTALLED_SKILLS_JSON; subprocess: the
// host's open-session). But the same tool also opens the skills the CLI ships
// inside its binary (update-config, simplify, init, …), and only two of those
// can be switched off (bundled-skills-env.ts). `update-config`, for one, has
// the model set up hooks in a settings file nothing loads and then say done.
//
// So the PreToolUse hook (pre-tool-use.ts) refuses any `Skill` call whose name
// is not a folder in the projection. Two pieces live here:
//
//   - `readProjectedSkills` builds that allowlist ONCE, at boot: after
//     runRunner materialized the projection, before the model has had a turn.
//     The projection is locked 0555 when written and nothing rewrites it
//     mid-session, so a snapshot is exact; a folder that appears later is not
//     on it. Folder names only, with no frontmatter parsing: the CLI lists a
//     user skill by its folder name (measured on CLI 2.1.119), and every AX
//     source writes folder == `name:` (the skills store keys a skill by its
//     manifest name; a connector bundle's folder and synthetic `name:` are
//     both its derived dir id).
//
//   - `skillRefusal` decides one call. `tool_input.skill` is model output, and
//     the refusal travels as an `is_error` tool_result that is persisted and
//     rendered in the web transcript (TASK-239), so the name is echoed back
//     only when it is a plain short name.
//
// Fails closed throughout: no config dir, an unreadable projection, or no
// projection passed to the hook all mean no skill can be invoked. A projection
// that could not be read carries that cause (`loadError`), so the refusal says
// the skills couldn't be read rather than the false "not one of this agent's
// skills".
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * The skills AX installed for this session, as read at boot.
 *
 *   - `names`: the folder names under `<configDir>/skills`.
 *   - `loadError`: set when the projection could not be read (no config dir,
 *     or a read error other than "no `skills/` directory"). `names` is then
 *     empty and every `Skill` call is refused, with a sentence that says why.
 *     The value is for logs and tests only; it never reaches the model.
 */
export type ProjectedSkills = {
  readonly names: ReadonlySet<string>;
  readonly loadError?: string;
};

/**
 * Reads the projection under `<configDir>/skills`. Real directories only (a
 * symlink is not one, so it is left out). Never throws. No `skills/`
 * directory is the normal shape of a session with no skills: no names and no
 * error, silently. No config dir, or any other read error, is no names plus a
 * `loadError` and one log line, because every `Skill` call will then be
 * refused.
 */
export async function readProjectedSkills(
  configDir: string | undefined,
  log: (line: string) => void = (line) =>
    process.stderr.write(`runner: projected-skills: ${line}\n`),
): Promise<ProjectedSkills> {
  if (configDir === undefined || configDir.length === 0) {
    log('no CLAUDE_CONFIG_DIR; every Skill call will be refused');
    return { names: new Set(), loadError: 'no CLAUDE_CONFIG_DIR' };
  }
  const skillsDir = path.join(configDir, 'skills');
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return { names: new Set(entries.filter((d) => d.isDirectory()).map((d) => d.name)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { names: new Set() };
    const cause = code ?? String(err);
    log(`could not read ${skillsDir} (${cause}); every Skill call will be refused`);
    return { names: new Set(), loadError: cause };
  }
}

/**
 * A skill name safe to quote back. The CLI's own skill names are kebab-case,
 * AX's are `^[a-z][a-z0-9-]{0,63}$`, and a plugin skill is `plugin:skill`;
 * nothing here can carry whitespace, a newline or markup into the transcript.
 */
const ECHOABLE_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

/**
 * Why a `Skill` call is refused, or `undefined` when it names a skill AX
 * installed. The name is `tool_input.skill`, trimmed, with ONE leading `/`
 * removed (the CLI accepts `/name` for `name`); anything that is not a
 * non-empty string names no skill and is refused.
 */
export function skillRefusal(
  toolInput: unknown,
  projected: ProjectedSkills,
): string | undefined {
  const raw =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>)['skill']
      : undefined;
  let name = typeof raw === 'string' ? raw.trim() : '';
  if (name.startsWith('/')) name = name.slice(1);
  const label = ECHOABLE_SKILL_NAME_RE.test(name) ? `"${name}"` : 'That skill';
  if (projected.loadError !== undefined) {
    return (
      `${label} isn't available, because this agent's skills couldn't be read when the ` +
      'session started. Use the tools you were given.'
    );
  }
  if (name !== '' && projected.names.has(name)) return undefined;
  return (
    `${label} is not one of this agent's skills, so it isn't available here. ` +
    'Use the skills and tools you were given. To do something on a schedule, create a routine.'
  );
}
