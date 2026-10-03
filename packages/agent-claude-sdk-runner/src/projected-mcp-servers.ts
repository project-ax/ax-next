// ---------------------------------------------------------------------------
// Connector MCP servers: the last mile from the installed-skills projection to
// the SDK's `mcpServers` option (TASK-760).
//
// `materializeInstalledSkillsFromEnv` (k8s) and sandbox-subprocess's
// open-session both write each connector's MCP servers as a `.mcp.json` next to
// its synthetic SKILL.md under `$CLAUDE_CONFIG_DIR/skills/<id>/`, keyed by the
// host-minted `toolNamespace` (TASK-734). The comments around that writer used
// to say the SDK "discovers `.mcp.json` alongside each skill dir via the 'user'
// setting source". It does not. Measured against the pinned binary (CLI
// 2.1.119, SDK 0.2.119): the CLI reads `.mcp.json` from exactly two places —
// the project scope (cwd and its ancestors, and only with the 'project'
// setting source, which Phase 3 dropped on purpose) and a PLUGIN root. A skill
// directory is neither, so every connector server was written and then
// ignored, and no `mcp__<ns>__<tool>` ever reached the model.
// `connector-mcp-real-sdk.e2e.test.ts` pins both halves against the real
// binary: the projection alone offers nothing, the projection through this
// loader offers the tool.
//
// So the runner reads the projection itself and hands the servers to `query()`
// explicitly. Trust shape:
//   - Reads ONLY `$CLAUDE_CONFIG_DIR/skills/*/.mcp.json` — the host-written,
//     0555/0444 projection. Never the agent-writable workspace (`.claude/`,
//     cwd), which is the same I3 rule that keeps 'project' out of
//     settingSources.
//   - Real directories and regular files only; a symlink is not a
//     materialized bundle (lstat, no follow).
//   - Only keys shaped like a host-minted connector namespace (`c` + 10 hex)
//     are loaded — exactly the shape `classifySdkToolName` lifts to
//     `mcp.<ns>.<tool>`, so every loaded tool reaches tool.pre-call under a
//     canonical, policy-addressable name. Anything else is skipped and logged.
//   - Every entry is re-validated with the same `validateMcpEntry` the writer
//     used (no command/url cross-contamination, header values must be
//     credential placeholders). Credentials keep flowing only through the
//     credential proxy; nothing here sees a real secret.
//   - A duplicate namespace across two bundles is ambiguous; the first (in
//     sorted dir order) wins and the second is logged. The host never mints
//     the same namespace twice, so this is a drift guard.
//
// NEVER THROWS. A bad bundle degrades to "that connector's tools are missing,
// with a stderr line naming why" — never a boot failure for the session.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { validateMcpEntry } from '@ax/agent-runner-core';
import { CONNECTOR_TOOL_NAMESPACE_RE } from './tool-names.js';

const MCP_CONFIG_FILE = '.mcp.json';
/** The writer's caps (≤32 args × 256 chars, ≤32 env, ≤5 headers) fit easily. */
const MAX_MCP_JSON_BYTES = 256 * 1024;

export interface ProjectedMcpServers {
  /** Ready for `query({ options: { mcpServers } })`, keyed by toolNamespace. */
  servers: Record<string, McpServerConfig>;
  /** One human-readable reason per skipped file or server (also logged). */
  skipped: string[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `.mcp.json` value shape the materializer writes back into the
 * `{ name, transport, ... }` shape `validateMcpEntry` checks.
 */
function toEntry(name: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const { type, ...rest } = v;
  if (type === 'http') return { name, transport: 'http', ...rest };
  if (type === undefined || type === 'stdio') return { name, transport: 'stdio', ...rest };
  // sse / sdk / anything else: the materializer never writes it.
  return { name, transport: String(type) };
}

function toSdkConfig(e: ReturnType<typeof validateMcpEntry>): McpServerConfig {
  if (e.transport === 'http') {
    return { type: 'http', url: e.url as string, ...(e.headers ? { headers: e.headers } : {}) };
  }
  return { type: 'stdio', command: e.command as string, args: e.args ?? [], env: e.env ?? {} };
}

export async function loadProjectedMcpServers(
  configDir: string | undefined,
  log: (line: string) => void = (line) => process.stderr.write(`runner: connector-mcp: ${line}\n`),
): Promise<ProjectedMcpServers> {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  const skip = (why: string): void => {
    skipped.push(why);
    log(why);
  };
  if (configDir === undefined || configDir.length === 0) return { servers, skipped };

  const skillsDir = path.join(configDir, 'skills');
  let names: string[];
  try {
    names = (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    // No projection is the normal case for a session with no skills/connectors.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      skip(`could not read ${skillsDir}: ${errText(err)}`);
    }
    return { servers, skipped };
  }

  for (const dir of names) {
    const file = path.join(skillsDir, dir, MCP_CONFIG_FILE);
    let raw: string;
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) {
        skip(`skills/${dir}/${MCP_CONFIG_FILE} is not a regular file — ignored`);
        continue;
      }
      if (st.size > MAX_MCP_JSON_BYTES) {
        skip(`skills/${dir}/${MCP_CONFIG_FILE} is ${st.size} bytes (cap ${MAX_MCP_JSON_BYTES}) — ignored`);
        continue;
      }
      raw = await fs.readFile(file, 'utf-8');
    } catch (err) {
      // Most bundles (plain skills) carry no `.mcp.json` at all.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        skip(`could not read skills/${dir}/${MCP_CONFIG_FILE}: ${errText(err)}`);
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      skip(`skills/${dir}/${MCP_CONFIG_FILE} is not valid JSON: ${errText(err)}`);
      continue;
    }
    const block =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['mcpServers']
        : undefined;
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      skip(`skills/${dir}/${MCP_CONFIG_FILE} has no mcpServers object — ignored`);
      continue;
    }

    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (!CONNECTOR_TOOL_NAMESPACE_RE.test(key)) {
        skip(`skills/${dir}: server '${key}' is not a connector tool namespace — ignored`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(servers, key)) {
        skip(`skills/${dir}: server '${key}' is already loaded from another bundle — ignored`);
        continue;
      }
      try {
        servers[key] = toSdkConfig(validateMcpEntry(toEntry(key, value)));
      } catch (err) {
        skip(`skills/${dir}: server '${key}' failed validation: ${errText(err)}`);
      }
    }
  }
  return { servers, skipped };
}
