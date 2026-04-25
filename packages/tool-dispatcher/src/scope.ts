import type { ToolDescriptor } from '@ax/core';

// ---------------------------------------------------------------------------
// Per-agent tool/MCP scope filter (Week 9.5, Task 7).
//
// Pure function — no bus access, no I/O. The catalog itself stays global
// (single source of truth, invariant I4); this filter is applied at
// `tool:list` time so the calling agent sees only the tools its frozen
// agentConfig.allowedTools / mcpConfigIds permit.
//
// MCP namespacing pattern: every MCP-sourced tool has a name shaped like
// `mcp.${serverId}.${toolName}` — owned by `@ax/mcp-client/src/tool-names.ts`
// (`buildNamespacedName`). We extract the `serverId` segment by hand here
// rather than importing across plugins (invariant I2), but the prefix and
// separator must stay in lockstep with mcp-client. If mcp-client ever
// changes the format, the contract test in mcp-client + the cross-tenant
// integration test in tool-dispatcher together flag the drift.
//
// Defensive bias: malformed `mcp.*` names (no second segment, empty
// configId) are dropped, not retained as natives. An attacker who manages
// to register a descriptor named `mcp.foo` must not get a free
// cross-tenant pass just because the prefix didn't parse.
//
// Wildcard sentinel: if BOTH `allowedTools` AND `mcpConfigIds` are empty,
// the entire catalog is returned unfiltered. This matches the contract
// the `@ax/cli` dev-agents-stub locked in (see its file comment): the
// stub's defaults are empty-empty, meaning "this is a single-tenant dev
// loop, expose everything." A real multi-tenant agent SHOULD always carry
// at least one explicit entry — admin endpoints in Task 9 are the place
// to enforce that, since refusing empty-empty here would silently break
// the dev CLI without flagging anything to a confused admin. We document
// the trade-off, log it via the call site, and leave the cardinality
// gate where it belongs (the agents-create endpoint).
// ---------------------------------------------------------------------------

const MCP_NAMESPACE_PREFIX = 'mcp.';

export interface AgentToolScope {
  /** Exact native-tool names this agent may see/call. */
  allowedTools: readonly string[];
  /** MCP server config ids whose tools this agent may see/call. */
  mcpConfigIds: readonly string[];
}

/**
 * Return only the descriptors permitted by `scope`. Order is preserved;
 * descriptor objects are returned by reference (no clones), since the
 * caller treats them as read-only.
 */
export function filterByAgentScope(
  descriptors: readonly ToolDescriptor[],
  scope: AgentToolScope,
): ToolDescriptor[] {
  // Wildcard sentinel — see file header. Returns a fresh array (so the
  // caller can mutate it safely) but reuses descriptor identity.
  if (scope.allowedTools.length === 0 && scope.mcpConfigIds.length === 0) {
    return [...descriptors];
  }
  const allowedNames = new Set(scope.allowedTools);
  const allowedMcpIds = new Set(scope.mcpConfigIds);
  const out: ToolDescriptor[] = [];
  for (const d of descriptors) {
    if (d.name.startsWith(MCP_NAMESPACE_PREFIX)) {
      const after = d.name.slice(MCP_NAMESPACE_PREFIX.length);
      const dot = after.indexOf('.');
      // No second segment, or empty configId — drop. We do NOT fall back
      // to the allowedTools allow-list for these: a name in the `mcp.*`
      // namespace that doesn't parse as `mcp.<id>.<rest>` is malformed,
      // and the safe default is "invisible to all agents" rather than
      // "natively visible to whoever has it allow-listed".
      if (dot <= 0) continue;
      const configId = after.slice(0, dot);
      if (allowedMcpIds.has(configId)) {
        out.push(d);
      }
      continue;
    }
    if (allowedNames.has(d.name)) {
      out.push(d);
    }
  }
  return out;
}
