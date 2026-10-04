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

/**
 * How an edit moved a connector's tool namespaces (TASK-752). A namespace is
 * a hash of the server NAME, so renaming a server gives its tools a new
 * namespace — and everything keyed to the old one (admin per-tool defaults,
 * every agent's per-tool choices) would be orphaned. This works out which
 * old namespaces became which new ones, and which simply went away.
 *
 * TASK-755: a server that kept its name but now points somewhere else (a new
 * endpoint) is also reported as removed. Its namespace stays the same — it is
 * still a hash of the name — but the choices stored under it were made for a
 * different service, so they must not carry over. Dropping them puts every
 * tool of the new address back to Ask first.
 */
export interface ToolNamespaceChange {
  /** Same server, new name: carry its per-tool state across. */
  renamed: Array<{ from: ToolNamespaceEntry; to: ToolNamespaceEntry }>;
  /**
   * Drop the per-tool state under these namespaces: a server that is no longer
   * there, or (TASK-755) one that kept its name but changed its endpoint.
   */
  removed: ToolNamespaceEntry[];
}

type ServerSpec = Capabilities['mcpServers'][number];

/**
 * The fields that say WHICH server this is. A server whose name changed but
 * whose endpoint did not is the same server, renamed. Credentials and
 * allowed hosts are configuration of that server, not its identity, so an edit
 * that changes them alongside the name is still a rename.
 */
function endpointOf(spec: ServerSpec): string {
  return JSON.stringify([spec.transport, spec.url ?? null]);
}

/** First spec per name — a duplicated name derives one namespace anyway. */
function byName(specs: readonly ServerSpec[]): Map<string, ServerSpec> {
  const out = new Map<string, ServerSpec>();
  for (const s of specs) if (!out.has(s.name)) out.set(s.name, s);
  return out;
}

/**
 * Diff a connector's MCP servers before and after an edit.
 *
 * A server counts as RENAMED only when it is unambiguous: its old name is gone,
 * a new name appeared, and exactly one vanished server and exactly one new
 * server share the endpoint. Anything less certain is REMOVED, which drops the
 * old per-tool state rather than handing it to a server nobody chose it for —
 * the new namespace then starts with no rows, i.e. Ask first.
 *
 * A name that is present on both sides keeps its namespace. If its endpoint is
 * unchanged it is neither renamed nor removed. If its endpoint CHANGED it is
 * REMOVED (TASK-755): same name, different service, so the old Allow/Ask/Deny
 * choices are dropped rather than handed to a server nobody chose them for.
 * (So swapping two servers' endpoints between their names resets both, which
 * is the safe reading of that edit.)
 */
export function diffToolNamespaces(
  ownerUserId: string,
  connectorId: string,
  before: readonly ServerSpec[],
  after: readonly ServerSpec[],
): ToolNamespaceChange {
  const oldByName = byName(before);
  const newByName = byName(after);
  const gone = [...oldByName.values()].filter((s) => !newByName.has(s.name));
  const added = [...newByName.values()].filter((s) => !oldByName.has(s.name));
  const entry = (spec: ServerSpec): ToolNamespaceEntry => ({
    server: spec.name,
    toolNamespace: deriveToolNamespace(ownerUserId, connectorId, spec.name),
  });

  const renamed: ToolNamespaceChange['renamed'] = [];
  const removed: ToolNamespaceEntry[] = [];
  for (const old of gone) {
    const ep = endpointOf(old);
    const candidates = added.filter((s) => endpointOf(s) === ep);
    const rivals = gone.filter((s) => endpointOf(s) === ep);
    const only = candidates.length === 1 && rivals.length === 1 ? candidates[0] : undefined;
    if (only !== undefined) {
      renamed.push({ from: entry(old), to: entry(only) });
    } else {
      removed.push(entry(old));
    }
  }
  for (const [name, now] of newByName) {
    const was = oldByName.get(name);
    if (was !== undefined && endpointOf(was) !== endpointOf(now)) removed.push(entry(was));
  }
  return { renamed, removed };
}
