// ---------------------------------------------------------------------------
// Connector MCP servers → the SDK's `mcpServers` option (TASK-760).
//
// The loader (trust shape, validation, never-throws) lives in
// `@ax/agent-runner-core` since TASK-826, shared with the aisdk runner. This
// is only the last-mile adapter: the runner-neutral server becomes the SDK's
// http `McpServerConfig`. See runner-core's `projected-mcp-servers.ts` for
// why the runner reads the projection itself at all — the CLI never reads a
// skill directory's `.mcp.json` (pinned by connector-mcp-real-sdk.e2e.test.ts).
// ---------------------------------------------------------------------------

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { loadProjectedMcpServers as loadProjection } from '@ax/agent-runner-core';

export interface ProjectedMcpServers {
  /** Ready for `query({ options: { mcpServers } })`, keyed by toolNamespace. */
  servers: Record<string, McpServerConfig>;
  /** One human-readable reason per skipped file or server (also logged). */
  skipped: string[];
}

export async function loadProjectedMcpServers(
  configDir: string | undefined,
  log?: (line: string) => void,
): Promise<ProjectedMcpServers> {
  const { servers, skipped } = await loadProjection(configDir, log);
  const out: Record<string, McpServerConfig> = {};
  for (const [ns, s] of Object.entries(servers)) {
    out[ns] = { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
  }
  return { servers: out, skipped };
}
