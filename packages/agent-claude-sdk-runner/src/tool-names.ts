// ---------------------------------------------------------------------------
// Tool-name classifier for claude-agent-sdk tool names.
//
// The claude-agent-sdk surfaces three flavors of tool in `canUseTool` and
// `PostToolUse`:
//
//   1. Built-in SDK tools — names like `Bash`, `Read`, `Edit`, ... These
//      arrive verbatim. Our host-side `tool:pre-call` subscribers see the
//      name as-is and decide whether to permit them.
//
//   2. MCP-hosted tools served from one of our two in-process MCP servers:
//      `ax-host-tools` (host-mcp-server.ts — `executesIn: 'host'`) and
//      `ax-sandbox-tools` (sandbox-mcp-server.ts — `executesIn: 'sandbox'`).
//      The SDK renames them to `mcp__<server>__<tool>` at the canUseTool
//      boundary. We strip the appropriate `mcp__<server>__` prefix so
//      subscribers see the ax-native tool name they registered.
//
//   3. Disabled built-ins — things we don't want the agent reaching at
//      all: WebFetch / WebSearch (raw network egress that bypasses the
//      credential-proxy / egress policy), plus `Task` (the nested-agent
//      surface that would spawn a sub-agent outside our hook bus). The
//      runner sets these in `disallowedTools` too; the classifier provides
//      defense in depth so `canUseTool` refuses even if the disallow list
//      ever slips.
//
//      NOTE on `Skill`: previously also denied here on the same
//      "bypass our hook bus" rationale, but Phase 0 of the skill-install
//      workflow (I-P0-1, docs/plans/2026-05-17-skill-install-phase-0-impl.md)
//      flips Skill from "denied at every layer" to "the intended SDK-native
//      skill-discovery path." Skill is now in `allowedTools` and the SDK
//      reads skills from $CLAUDE_CONFIG_DIR/skills/ (host-controlled) and
//      <workspace>/.claude/skills/ (a narrow symlink to .ax/skills,
//      gated at workspace:pre-apply by @ax/validator-skill — see commit
//      521f206c, which vetoes agent writes to .claude/settings.json,
//      CLAUDE.md, and other SDK-config paths that would let an agent
//      escalate via the now-enabled user/project setting sources).
//      Skill is NOT a nested-agent bypass; `Task` still is.
//
// Anything else — including MCP tools from a DIFFERENT server (not ours) —
// falls through as kind 'builtin' with the full name preserved. That's a
// deliberate fallback: third-party MCP servers are out of scope for v1 but
// the classifier shouldn't silently swallow them if one shows up. The
// host-side subscribers will see the full `mcp__<other>__<tool>` name and
// can decide how to handle it (most likely: reject).
// ---------------------------------------------------------------------------

export const MCP_HOST_SERVER_NAME = 'ax-host-tools';
export const MCP_SANDBOX_SERVER_NAME = 'ax-sandbox-tools';

export const DISABLED_BUILTINS = [
  'WebFetch',
  'WebSearch',
  'Task',
] as const;

export type SdkToolClass =
  | { kind: 'builtin'; axName: string }
  | { kind: 'mcp-host'; axName: string }
  | { kind: 'mcp-sandbox'; axName: string }
  | { kind: 'disabled' };

const MCP_HOST_PREFIX = `mcp__${MCP_HOST_SERVER_NAME}__`;
const MCP_SANDBOX_PREFIX = `mcp__${MCP_SANDBOX_SERVER_NAME}__`;

export function classifySdkToolName(sdkName: string): SdkToolClass {
  if ((DISABLED_BUILTINS as readonly string[]).includes(sdkName)) {
    return { kind: 'disabled' };
  }
  if (sdkName.startsWith(MCP_HOST_PREFIX)) {
    return { kind: 'mcp-host', axName: sdkName.slice(MCP_HOST_PREFIX.length) };
  }
  if (sdkName.startsWith(MCP_SANDBOX_PREFIX)) {
    return { kind: 'mcp-sandbox', axName: sdkName.slice(MCP_SANDBOX_PREFIX.length) };
  }
  // Fallback: pass the name through unchanged. Covers built-in SDK tools
  // (Bash, Read, Edit, …) AND unknown-to-us MCP tools from other servers.
  // Host-side subscribers see the verbatim name and decide.
  return { kind: 'builtin', axName: sdkName };
}
