/**
 * tool-name — normalize the SDK/MCP-namespaced tool names that reach the
 * transcript UI back to the bare `ax`-native name the renderers key on.
 *
 * The claude-agent-sdk renames an MCP-hosted tool to `mcp__<server>__<tool>`
 * at the `canUseTool` boundary, and that renamed name is what gets persisted
 * and what flows into a `tool-call` message part's `toolName` in the UI. So a
 * published artifact arrives as `mcp__ax-sandbox-tools__artifact_publish`,
 * not the bare `artifact_publish` the chip renderer was keyed on — which left
 * the download chip rendering a dead "unknown artifact" pill (TASK-81).
 *
 * This strips a leading `mcp__<server>__` segment so the UI can match the
 * ax-native name regardless of whether the runner emitted the bare or the
 * namespaced form. We only consume the result for *display keying* (which
 * renderer to pick / which tool result to pair with an artifact link); we are
 * deliberately NOT re-deriving any trust or capability decision from it (the
 * runner already classified + permitted the call host-side via
 * `classifySdkToolName` — this is purely cosmetic routing on already-rendered
 * transcript content).
 *
 * We intentionally don't import the runner's `classifySdkToolName` /
 * `MCP_SANDBOX_SERVER_NAME` — plugins talk through the hook bus, never via
 * cross-plugin imports (invariant 2). The `mcp__<server>__` shape is an SDK
 * wire convention, not a runner-private detail, so re-stating the tiny regex
 * here is correct rather than a duplicated source of truth.
 */

// `mcp__<server>__<tool>` — the tool name can itself contain `__` (the runner
// classifier tolerates `some_tool__with_delims`), so we strip ONLY the first
// `mcp__<server>__` segment and keep everything after it verbatim. The server
// segment is matched as the shortest run up to the next `__` (`.*?`), so the
// tool name's own delimiters survive. Our two servers (`ax-host-tools`,
// `ax-sandbox-tools`) are hyphenated, but this stays correct for any server
// name that doesn't itself contain `__`.
const MCP_PREFIX = /^mcp__.*?__/;

/**
 * Strip a leading `mcp__<server>__` prefix from an SDK tool name, returning
 * the bare ax-native tool name. Names without the prefix (built-in SDK tools,
 * already-bare names) pass through unchanged.
 */
export function stripMcpToolPrefix(toolName: string): string {
  return toolName.replace(MCP_PREFIX, '');
}

/**
 * The SDK wire name for the sandbox `artifact_publish` tool —
 * `mcp__ax-sandbox-tools__artifact_publish`. The runner serves it from its
 * `ax-sandbox-tools` in-process MCP server and the SDK renames it to this at
 * the canUseTool boundary; that renamed name is what gets persisted and what
 * the transcript renderer must match.
 *
 * We re-state the literal here rather than importing the runner's
 * `MCP_SANDBOX_SERVER_NAME` (invariant 2: no cross-plugin imports). The
 * `assistant-ui` `tools.by_name` lookup is an exact-match dictionary on the
 * raw `part.toolName`, so registering the chip renderer under BOTH this name
 * and the bare `artifact_publish` is what makes it resolve for the live + the
 * already-stripped/legacy form alike.
 */
export const ARTIFACT_PUBLISH_TOOL_NAME = 'artifact_publish';
export const MCP_ARTIFACT_PUBLISH_TOOL_NAME =
  'mcp__ax-sandbox-tools__artifact_publish';
