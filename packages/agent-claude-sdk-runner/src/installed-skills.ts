// ---------------------------------------------------------------------------
// installed-skills — materialize AX_INSTALLED_SKILLS_JSON at runner boot.
//
// K8s pods can't have the host write files into them at create-time, so the
// sandbox-k8s plugin passes installed-skill content as AX_INSTALLED_SKILLS_JSON
// (JSON-encoded array). The runner reads it from process.env BEFORE the SDK
// spawns and writes each skill's bundle FILE TREE (SKILL.md + extra files) to
// $CLAUDE_CONFIG_DIR/skills/<id>/, then chmods the parent dir to 0555 so the
// runner's own tool calls can't extend or overwrite it. Every file path is
// re-validated at this extract boundary (JIT Phase 1a — defense in depth).
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

// JIT Phase 1a — extra-file path safety, re-validated at the runner's extract
// boundary (defense in depth, the validateMcpEntry pattern). A buggy or
// compromised host could otherwise write outside the skill dir or smuggle an
// SDK-config file (`.mcp.json` is generated from mcpServers, NOT supplied;
// `.claude/*` / `.git/*` are auto-config). `SKILL.md` is the one allowed
// uppercase path (the bundle root). Mirrors @ax/skills bundle-files.ts and
// @ax/sandbox-protocol's InstalledSkillSchema, kept independent per invariant
// I2 (no cross-plugin import across the trust boundary).
const SKILL_FILE_PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;

function assertSafeRelPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) {
    throw new Error(`invalid skill file path: ${String(p)}`);
  }
  if (p.includes('..') || p.startsWith('/') || !(p === 'SKILL.md' || SKILL_FILE_PATH_RE.test(p))) {
    throw new Error(`invalid skill file path (traversal/charset): ${p}`);
  }
  // Reject `.` / `..` path SEGMENTS — the charset allows a bare `.`, but
  // path.join normalizes it (`.` → the skill dir itself; `a/./b` → `a/b`).
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new Error(`invalid skill file path ('.' or '..' segment): ${p}`);
  }
  if (p === '.mcp.json' || p.startsWith('.claude/') || p.startsWith('.git/')) {
    throw new Error(`reserved skill file path: ${p}`);
  }
}

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

// Symmetric with the manifest parser + sandbox schemas: 32 entries per array,
// 256 chars per string. Defense in depth — the host already validated upstream
// but the runner re-checks at its trust boundary.
const MCP_ARGS_MAX = 32;
const MCP_ARG_LEN_MAX = 256;
const MCP_ENV_MAX = 32;
const MCP_ENV_LEN_MAX = 256;

// Defense-in-depth validation of an mcpServers entry. The sandbox-k8s zod
// schema already enforced this upstream, but the runner re-checks at the
// trust boundary — a buggy or compromised host process could otherwise spawn
// arbitrary commands inside the sandbox via .mcp.json.
//
// DRIFT GUARD (ARCH-11): this hand-rolled validator deliberately duplicates
// `@ax/sandbox-protocol`'s `McpServerSchema` rather than importing it — the
// runner stays independent of the host contract package so the re-validation
// is genuine defense-in-depth (invariant I2 — no cross-plugin imports across
// the trust boundary). To keep the two in sync without coupling them, both are
// asserted against ONE shared golden-vectors fixture
// (`@ax/sandbox-protocol`'s `src/__tests__/fixtures/mcp-server-golden-vectors.json`):
//   - the schema side: sandbox-protocol's `mcp-server-drift.test.ts`
//   - the runner side: this package's `__tests__/mcp-server-drift.test.ts`
//     (reads the fixture by repo-root-relative path — NO package import).
// If either validator's verdict on a vector flips, one suite fails → CI red.
// Exported solely so that drift test can drive it; it is a pure function (no
// I/O), so exporting grants no runtime capability.
//
// Two KNOWN, intentional divergences from `McpServerSchema` (encoded as
// non-`core` vectors in the fixture, NOT treated as drift):
//   1. This validator ignores `allowedHosts` / `credentials` — they don't
//      affect the `.mcp.json` shape the runner emits (only name/transport/
//      command/args/env/url do), so it neither reads nor validates them.
//   2. This validator additionally caps env to ≤32 entries and ≤256-char keys
//      and values; `McpServerSchema`'s `z.record(z.string(), z.string())` caps
//      neither. The runner is the LAST gate, so being stricter is the safe
//      direction (a follow-up may tighten the schema to match).
export function validateMcpEntry(value: unknown): {
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
    if (!Array.isArray(v['args'])) {
      throw new Error(`mcpServers entry '${v['name']}' args must be string[]`);
    }
    if (v['args'].length > MCP_ARGS_MAX) {
      throw new Error(
        `mcpServers entry '${v['name']}' has too many args (max ${MCP_ARGS_MAX})`,
      );
    }
    if (
      !v['args'].every(
        (a): a is string => typeof a === 'string' && a.length <= MCP_ARG_LEN_MAX,
      )
    ) {
      throw new Error(
        `mcpServers entry '${v['name']}' has an arg over ${MCP_ARG_LEN_MAX} chars or non-string`,
      );
    }
    out.args = v['args'] as string[];
  }
  if (v['env'] !== undefined) {
    if (
      typeof v['env'] !== 'object' ||
      v['env'] === null ||
      Array.isArray(v['env'])
    ) {
      throw new Error(`mcpServers entry '${v['name']}' env must be Record<string,string>`);
    }
    const envEntries = Object.entries(v['env'] as Record<string, unknown>);
    if (envEntries.length > MCP_ENV_MAX) {
      throw new Error(
        `mcpServers entry '${v['name']}' env has too many entries (max ${MCP_ENV_MAX})`,
      );
    }
    for (const [k, val] of envEntries) {
      if (k.length > MCP_ENV_LEN_MAX) {
        throw new Error(
          `mcpServers entry '${v['name']}' env key length must be ≤ ${MCP_ENV_LEN_MAX}`,
        );
      }
      if (typeof val !== 'string') {
        throw new Error(`mcpServers entry '${v['name']}' env must be Record<string,string>`);
      }
      if (val.length > MCP_ENV_LEN_MAX) {
        throw new Error(
          `mcpServers entry '${v['name']}' env value length must be ≤ ${MCP_ENV_LEN_MAX}`,
        );
      }
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

  // Transport-specific invariants — symmetric with the sandbox schemas'
  // .refine(). stdio requires a non-empty command and forbids url; http
  // requires url and forbids the stdio-only fields. Without these the runner
  // would happily JSON-encode a cross-contaminated .mcp.json that the SDK
  // either silently misinterprets or fails on at spawn time.
  if (v['transport'] === 'stdio') {
    if (out.command === undefined) {
      throw new Error(
        `mcpServers entry '${v['name']}' (stdio) is missing required 'command'`,
      );
    }
    if (out.url !== undefined) {
      throw new Error(
        `mcpServers entry '${v['name']}' (stdio) must not set 'url'`,
      );
    }
  } else {
    // transport === 'http'
    if (out.url === undefined) {
      throw new Error(
        `mcpServers entry '${v['name']}' (http) is missing required 'url'`,
      );
    }
    if (
      out.command !== undefined ||
      out.args !== undefined ||
      out.env !== undefined
    ) {
      throw new Error(
        `mcpServers entry '${v['name']}' (http) must not set 'command', 'args', or 'env'`,
      );
    }
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
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, files } objects');
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj['id'] !== 'string' || obj['id'].length === 0) {
      throw new Error('AX_INSTALLED_SKILLS_JSON entries must be { id, files } objects');
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
      files: unknown[];
      mcpServers?: unknown[];
    } = {
      id: obj['id'] as string,
      files: Array.isArray(obj['files']) ? obj['files'] : [],
      ...(obj['mcpServers'] !== undefined
        ? { mcpServers: obj['mcpServers'] as unknown[] }
        : {}),
    };
    if (!SKILL_ID_RE.test(e.id)) {
      throw new Error(`installed skill id '${e.id}' has invalid shape`);
    }
    if (!Array.isArray(obj['files']) || e.files.length === 0) {
      throw new Error(`installed skill '${e.id}' must carry a non-empty files array`);
    }
    const skillDir = path.join(skillsDir, e.id);
    await fs.mkdir(skillDir, { recursive: true, mode: 0o755 });

    // JIT Phase 1a — materialize the bundle's file tree. Re-validate every path
    // at this trust boundary (defense in depth) and add a post-join containment
    // guard (belt-and-suspenders over the regex) so nothing escapes skillDir.
    // Files are written read-only (0o444) — no exec bit; scripts run via their
    // interpreter, never by exec permission.
    let sawSkillMd = false;
    for (const rawFile of e.files) {
      if (typeof rawFile !== 'object' || rawFile === null || Array.isArray(rawFile)) {
        throw new Error(`installed skill '${e.id}' has a non-object file entry`);
      }
      const fileObj = rawFile as Record<string, unknown>;
      assertSafeRelPath(fileObj['path']);
      const filePath = fileObj['path'];
      if (typeof fileObj['contents'] !== 'string') {
        throw new Error(`installed skill '${e.id}' file '${filePath}' contents must be a string`);
      }
      if (filePath === 'SKILL.md') sawSkillMd = true;
      const full = path.join(skillDir, filePath);
      if (full !== skillDir && !full.startsWith(skillDir + path.sep)) {
        throw new Error(`skill file '${filePath}' escapes skill dir`);
      }
      await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
      await fs.writeFile(full, fileObj['contents'], { mode: 0o444, encoding: 'utf-8' });
    }
    if (!sawSkillMd) {
      throw new Error(`installed skill '${e.id}' is missing SKILL.md`);
    }

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

    // Lock the WHOLE bundle tree read-only — files are already 0o444; chmod
    // every directory (this skill dir + any nested subdirs) to 0o555 so the
    // model (which runs as the dir owner) can't unlink + recreate a
    // supposedly read-only bundled file inside an otherwise-writable subdir.
    // Deepest-first so traversal still works as we lock.
    await lockDirsReadOnly(skillDir);
  }
  await fs.chmod(skillsDir, 0o555);
}

/**
 * Recursively chmod every directory in the tree (deepest-first) to 0o555 so a
 * read-only skill bundle can't have its files swapped out from under it. Files
 * are written 0o444 separately; this only touches directories.
 */
async function lockDirsReadOnly(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      await lockDirsReadOnly(path.join(dir, ent.name));
    }
  }
  await fs.chmod(dir, 0o555);
}
