import { createHash } from 'node:crypto';
import type { Capabilities } from './types.js';

/**
 * Canonical tool namespace for a connector's MCP server.
 *
 * A connector's MCP tools reach the model as `mcp__<namespace>__<tool>` (the
 * SDK's naming) and reach the permission layer as the toolKey
 * `mcp.<namespace>.<tool>`. The `<namespace>` is what this file derives: an
 * OPAQUE, STABLE alias for one connector RECORD's MCP server.
 *
 * What it identifies. `(ownerUserId, connectorId)` is the identity of a
 * connector record — rows are keyed `(owner_user_id, connector_id)`, so two
 * owners can each have a connector called `linear` and they are different
 * records. `serverName` picks one entry of that record's
 * `capabilities.mcpServers`. The namespace is a hash of all three.
 *
 * What it deliberately does NOT take: the agent. The same connector record used
 * by two agents must produce the SAME namespace (one connector, one name for
 * its tools, everywhere). Per-agent permissions are keyed `(agentId, toolKey)`
 * elsewhere — the agent dimension lives in that key, not in the tool name.
 *
 * Why a hash and not the spec's own `name`. An authored or admin-created
 * connector picks its `mcpServers[].name` freely, so a name is neither unique
 * across records (collision: two different `linear` servers would share one
 * toolKey and one permission decision) nor safe to expose. The hash:
 *   - cannot collide across records by construction (owner + id are inputs),
 *   - keeps `mcp__<ns>__<tool>` well under the 64-char tool-name limit (11
 *     chars, whatever the connector/server names are),
 *   - satisfies the sandbox's `^[a-z][a-z0-9-]{0,63}$` name grammar, and
 *   - does not expose `ownerUserId` to the model (it is hashed, not embedded).
 *
 * The format is a stable contract: toolKeys persisted in per-agent permission
 * rows are `mcp.<namespace>.<tool>`, so changing the domain tag, the field
 * order, or the slice length would orphan every stored decision. Bump the
 * `/v1` tag only together with a migration.
 */

const DOMAIN_TAG = 'ax-connector-tool-namespace/v1';

/** Shape of a derived namespace: `c` + 10 lowercase hex chars (11 total). */
export const TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;

/**
 * Derive the namespace for one MCP server of one connector record.
 * `ownerUserId` MUST be the connector ROW owner, not the requesting user (a
 * shared connector resolved by a non-owner must yield the owner's namespace).
 * Fields are NUL-separated so shifting a boundary between adjacent fields
 * cannot produce a collision for any realistic input (connector ids are
 * `^[a-z0-9][a-z0-9_-]*$`, so the middle field can never contain NUL; owner ids
 * are opaque ids minted by the host).
 */
export function deriveToolNamespace(
  ownerUserId: string,
  connectorId: string,
  serverName: string,
): string {
  const digest = createHash('sha256')
    .update(`${DOMAIN_TAG}\0${ownerUserId}\0${connectorId}\0${serverName}`)
    .digest('hex');
  return `c${digest.slice(0, 10)}`;
}

/** One MCP server of a connector paired with its derived namespace. */
export interface ToolNamespaceEntry {
  /** The server's declared name inside the connector's capabilities. */
  server: string;
  /** The opaque namespace the server's tools are exposed under. */
  toolNamespace: string;
}

/**
 * Derive the namespace of every MCP server a connector declares, in
 * `capabilities.mcpServers` order. Empty for a connector with no MCP servers.
 * `ownerUserId` is the connector row owner (see {@link deriveToolNamespace}).
 */
export function deriveToolNamespaces(
  ownerUserId: string,
  connector: { id: string; capabilities: Pick<Capabilities, 'mcpServers'> },
): ToolNamespaceEntry[] {
  return connector.capabilities.mcpServers.map((spec) => ({
    server: spec.name,
    toolNamespace: deriveToolNamespace(ownerUserId, connector.id, spec.name),
  }));
}
