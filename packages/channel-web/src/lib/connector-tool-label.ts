/**
 * connector-tool-label — "Linear · Create issue" instead of a hash (TASK-744).
 *
 * Since TASK-734 a connector's MCP tool is named after an OPAQUE namespace,
 * `c` + 10 hex chars hashed from the connector record. It reaches this package
 * in two spellings:
 *
 *   - `mcp__c5e0235982f__create_issue` — the SDK wire name the claude-sdk
 *     runner persists on the transcript's `tool_use` block and streams in the
 *     live `tool-use` frame;
 *   - `mcp.c5e0235982f.create_issue` — the canonical toolKey the policy gate
 *     and the decision store see (`call.name` on a held call).
 *
 * Neither is something a person should read. This turns either into
 * "<connector name> · <tool>", using the namespace → connector-name map the
 * host read from `connectors:tool-labels` for THIS user; a namespace that is
 * not in the map (someone else's connector, a deleted one, no connectors
 * plugin) gets the tool name alone. The namespace itself is never returned.
 *
 * The regex is re-stated rather than imported from `@ax/connectors` or the
 * runner (invariant 2), and pinned to the same real derived literal their
 * tests pin (`c5e0235982f`), so a one-sided shape change is loud.
 *
 * Display only. Nothing may key a decision off the label.
 */

import { fenceLine } from './fence-line.js';
import { humanizeId } from './humanize.js';

/** toolNamespace → the connector's display name, as `connectors:tool-labels` returned it. */
export type ConnectorNames = ReadonlyMap<string, string>;

/** A host-minted connector tool namespace: `c` + 10 lowercase hex. */
export const CONNECTOR_TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;
const SDK_FORM = /^mcp__(c[0-9a-f]{10})__(.+)$/s;
const KEY_FORM = /^mcp\.(c[0-9a-f]{10})\.(.+)$/s;

/** Per-half caps: the label lands in a one-line step row and must leave room for detail. */
const CONNECTOR_NAME_MAX_CHARS = 40;
const TOOL_PART_MAX_CHARS = 48;

/** Either spelling → its parts, or null for every other tool name. */
export function parseConnectorToolName(
  name: string,
): { toolNamespace: string; tool: string } | null {
  const m = SDK_FORM.exec(name) ?? KEY_FORM.exec(name);
  if (m === null) return null;
  return { toolNamespace: m[1]!, tool: m[2]! };
}

/**
 * The canonical toolKey for either spelling (`mcp.<ns>.<tool>`), or the name
 * with any `mcp__<server>__` wrapper stripped for everything else. This is the
 * MATCH key for pairing a transcript step with the decision that held it: the
 * transcript says `mcp__<ns>__x`, the decision says `mcp.<ns>.x`, and they are
 * the same call.
 */
export function toolMatchName(name: string): string {
  const parsed = parseConnectorToolName(name);
  if (parsed !== null) return `mcp.${parsed.toolNamespace}.${parsed.tool}`;
  return name.replace(/^mcp__.*?__/, '');
}

/**
 * "<connector> · <tool>" for a connector tool, the tool alone when the
 * namespace is not one this person can name, or `undefined` when `name` is
 * not a connector tool at all (the caller keeps its existing wording).
 */
export function connectorToolLabel(
  name: string,
  connectors: ConnectorNames | undefined,
): string | undefined {
  const parsed = parseConnectorToolName(name);
  if (parsed === null) return undefined;
  const tool = fenceLine(humanizeId(parsed.tool), TOOL_PART_MAX_CHARS);
  const connectorName = connectors?.get(parsed.toolNamespace);
  const connector =
    connectorName === undefined ? null : fenceLine(connectorName, CONNECTOR_NAME_MAX_CHARS);
  // Never fall through to the caller's raw-name fallback for a connector
  // tool: on the toolKey spelling that fallback would print the hash.
  if (tool === null) return connector ?? 'Connector tool';
  return connector === null ? tool : `${connector} · ${tool}`;
}
