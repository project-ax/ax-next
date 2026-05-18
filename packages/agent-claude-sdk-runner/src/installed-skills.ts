// ---------------------------------------------------------------------------
// installed-skills — materialize AX_INSTALLED_SKILLS_JSON at runner boot.
//
// K8s pods can't have the host write files into them at create-time, so the
// sandbox-k8s plugin passes installed-skill content as AX_INSTALLED_SKILLS_JSON
// (JSON-encoded array). The runner reads it from process.env BEFORE the SDK
// spawns and writes each skill's SKILL.md to
// $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md, then chmods the parent dir to
// 0555 so the runner's own tool calls can't extend or overwrite it.
//
// This is the symmetric peer of sandbox-subprocess's in-process
// materialization (open-session.ts). The two providers' on-disk shape after
// open-session is identical; only the transport differs (file write vs. env
// var).
//
// The env var is consumed BY THIS MODULE — it is NOT forwarded into the SDK
// subprocess (not in ENV_ALLOWLIST in proxy-startup.ts). Forwarding it would
// put the full skill content into every SDK call's env unnecessarily.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const SKILL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export async function materializeInstalledSkillsFromEnv(): Promise<void> {
  const json = process.env['AX_INSTALLED_SKILLS_JSON'];
  if (typeof json !== 'string' || json.length === 0) return;

  const ccd = process.env['CLAUDE_CONFIG_DIR'];
  if (typeof ccd !== 'string' || ccd.length === 0) {
    throw new Error('AX_INSTALLED_SKILLS_JSON set but CLAUDE_CONFIG_DIR missing');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('AX_INSTALLED_SKILLS_JSON is not valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('AX_INSTALLED_SKILLS_JSON must be an array');
  }

  const skillsDir = path.join(ccd, 'skills');
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>)['id'] !== 'string' ||
      typeof (entry as Record<string, unknown>)['skillMd'] !== 'string'
    ) {
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, skillMd } objects');
    }
    const e = entry as { id: string; skillMd: string };
    if (!SKILL_ID_RE.test(e.id)) {
      throw new Error(`installed skill id '${e.id}' has invalid shape`);
    }
    const skillDir = path.join(skillsDir, e.id);
    await fs.mkdir(skillDir, { recursive: true, mode: 0o755 });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      e.skillMd,
      { mode: 0o444, encoding: 'utf-8' },
    );
  }
  await fs.chmod(skillsDir, 0o555);
}
