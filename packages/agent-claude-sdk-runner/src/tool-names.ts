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
//   2. MCP-hosted tools served from our in-process `ax-host-tools` MCP
//      server (see host-mcp-server.ts). The SDK renames them to
//      `mcp__<server>__<tool>` at the canUseTool boundary. We strip the
//      `mcp__ax-host-tools__` prefix so subscribers see the ax-native tool
//      name they registered.
//
//   3. Disabled built-ins — things we don't want the agent reaching at
//      all (WebFetch, WebSearch, plus nested-agent surfaces like Task/Skill
//      that would bypass our hook bus). The runner sets these in
//      `disallowedTools` too; the classifier provides defense in depth so
//      `canUseTool` refuses even if the disallow list ever slips.
//
// Anything else — including MCP tools from a DIFFERENT server (not ours) —
// falls through as kind 'builtin' with the full name preserved. That's a
// deliberate fallback: third-party MCP servers are out of scope for v1 but
// the classifier shouldn't silently swallow them if one shows up. The
// host-side subscribers will see the full `mcp__<other>__<tool>` name and
// can decide how to handle it (most likely: reject).
// ---------------------------------------------------------------------------

export const MCP_HOST_SERVER_NAME = 'ax-host-tools';

export const DISABLED_BUILTINS = [
  'WebFetch',
  'WebSearch',
  'Skill',
  'Task',
] as const;

export type SdkToolClass =
  | { kind: 'builtin'; axName: string }
  | { kind: 'mcp-host'; axName: string }
  | { kind: 'disabled' };

const MCP_HOST_PREFIX = `mcp__${MCP_HOST_SERVER_NAME}__`;

export function classifySdkToolName(sdkName: string): SdkToolClass {
  if ((DISABLED_BUILTINS as readonly string[]).includes(sdkName)) {
    return { kind: 'disabled' };
  }
  if (sdkName.startsWith(MCP_HOST_PREFIX)) {
    return { kind: 'mcp-host', axName: sdkName.slice(MCP_HOST_PREFIX.length) };
  }
  // Fallback: pass the name through unchanged. Covers built-in SDK tools
  // (Bash, Read, Edit, …) AND unknown-to-us MCP tools from other servers.
  // Host-side subscribers see the verbatim name and decide.
  return { kind: 'builtin', axName: sdkName };
}
