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

// Phase B (capabilities.mcpServers) — translate the parsed McpServerSpec
// into the Anthropic SDK's `.mcp.json` shape. stdio: { command, args, env }.
// http: { url, type: 'http' }. The SDK auto-loads `.mcp.json` from each
// skill dir via its `'project'` setting source. Twin of
// sandbox-subprocess/open-session.ts's `toMcpJsonShape` (I2 — no
// cross-plugin imports). The reason this helper lives here too (despite
// already running in the host-side sandbox path) is that for k8s the .mcp.json
// is materialized by the runner from AX_INSTALLED_SKILLS_JSON, not by the
// host; the subprocess sandbox runs both paths in-process. Keeping the
// translation local to each materializer avoids a cross-plugin coupling.
function toMcpJsonShape(s: {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}): unknown {
  if (s.transport === 'stdio') {
    return { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  }
  return { url: s.url, type: 'http' };
}

// Defense-in-depth validation of an mcpServers entry. The sandbox-k8s zod
// schema already enforced this upstream, but the runner re-checks at the
// trust boundary — a buggy or compromised host process could otherwise spawn
// arbitrary commands inside the sandbox via .mcp.json.
function validateMcpEntry(value: unknown): {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mcpServers entries must be objects');
  }
  const v = value as Record<string, unknown>;
  if (typeof v['name'] !== 'string' || !SKILL_ID_RE.test(v['name'])) {
    throw new Error(`mcpServers entry has invalid name '${String(v['name'])}'`);
  }
  if (v['transport'] !== 'stdio' && v['transport'] !== 'http') {
    throw new Error(`mcpServers entry '${v['name']}' has invalid transport`);
  }
  const out: {
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  } = { name: v['name'], transport: v['transport'] };
  if (v['command'] !== undefined) {
    if (typeof v['command'] !== 'string' || v['command'].length === 0) {
      throw new Error(`mcpServers entry '${v['name']}' command must be non-empty string`);
    }
    out.command = v['command'];
  }
  if (v['args'] !== undefined) {
    if (!Array.isArray(v['args']) || !v['args'].every((a) => typeof a === 'string')) {
      throw new Error(`mcpServers entry '${v['name']}' args must be string[]`);
    }
    out.args = v['args'] as string[];
  }
  if (v['env'] !== undefined) {
    if (
      typeof v['env'] !== 'object' ||
      v['env'] === null ||
      Array.isArray(v['env']) ||
      !Object.values(v['env']).every((x) => typeof x === 'string')
    ) {
      throw new Error(`mcpServers entry '${v['name']}' env must be Record<string,string>`);
    }
    out.env = v['env'] as Record<string, string>;
  }
  if (v['url'] !== undefined) {
    if (typeof v['url'] !== 'string') {
      throw new Error(`mcpServers entry '${v['name']}' url must be a string`);
    }
    try {
      // URL constructor throws on malformed input — matches the upstream zod
      // .url() guard.
      new URL(v['url']);
    } catch {
      throw new Error(`mcpServers entry '${v['name']}' url is not a valid URL`);
    }
    out.url = v['url'];
  }
  return out;
}

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

  // Empty array: nothing to materialize, nothing to lock. The Phase 0
  // sandbox init container already created the skills dir at 0o755;
  // chmodding it (or creating it just to chmod it) would surface an
  // ENOENT on tmpdir-based tests AND would lock a dir we never touched
  // in prod. Early-return — same Phase 0 default behavior.
  if (parsed.length === 0) return;

  const skillsDir = path.join(ccd, 'skills');
  await fs.mkdir(skillsDir, { recursive: true, mode: 0o755 });
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, skillMd } objects');
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj['id'] !== 'string' || obj['id'].length === 0) {
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, skillMd } objects');
    }
    if (typeof obj['skillMd'] !== 'string' || obj['skillMd'].length === 0) {
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, skillMd } objects');
    }
    // mcpServers is optional but, if present, must be an array. Each entry is
    // re-validated below (defense in depth — the host-side sandbox already
    // zod-validated this).
    if (obj['mcpServers'] !== undefined && !Array.isArray(obj['mcpServers'])) {
      throw new Error(
        `installed skill '${String(obj['id'])}' has non-array mcpServers`,
      );
    }
    const e: {
      id: string;
      skillMd: string;
      mcpServers?: unknown[];
    } = {
      id: obj['id'] as string,
      skillMd: obj['skillMd'] as string,
      ...(obj['mcpServers'] !== undefined
        ? { mcpServers: obj['mcpServers'] as unknown[] }
        : {}),
    };
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
    // Phase B — write `.mcp.json` alongside SKILL.md so the SDK's `'project'`
    // setting source auto-discovers the bundled MCP servers. Validate each
    // entry first (defense-in-depth: even though sandbox-k8s ran zod
    // upstream, a buggy host could otherwise spawn arbitrary commands
    // inside the sandbox).
    if (e.mcpServers !== undefined && e.mcpServers.length > 0) {
      const validated = e.mcpServers.map(validateMcpEntry);
      const mcpJsonContent = JSON.stringify(
        {
          mcpServers: Object.fromEntries(
            validated.map((s) => [s.name, toMcpJsonShape(s)]),
          ),
        },
        null,
        2,
      );
      await fs.writeFile(
        path.join(skillDir, '.mcp.json'),
        mcpJsonContent,
        { mode: 0o444, encoding: 'utf-8' },
      );
    }
  }
  await fs.chmod(skillsDir, 0o555);
}
