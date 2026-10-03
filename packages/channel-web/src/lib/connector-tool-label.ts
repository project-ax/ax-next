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
 * TASK-753: the label is composed by `@ax/core/humanize`'s
 * `connectorToolLabel` — the same function `@ax/decisions` uses for the
 * approval card — so one call reads the same on the card, the activity rail
 * and the transcript. And when `connectors:tool-labels` carried the MCP
 * server's own cached title for the tool, that title wins over the humanized
 * name.
 *
 * The regex is re-stated rather than imported from `@ax/connectors` or the
 * runner (invariant 2), and pinned to the same real derived literal their
 * tests pin (`c5e0235982f`), so a one-sided shape change is loud.
 *
 * Display only. Nothing may key a decision off the label.
 */

import {
  CONNECTOR_NAME_MAX_CHARS,
  CONNECTOR_TOOL_PART_MAX_CHARS,
  connectorToolLabel as composeConnectorToolLabel,
} from '@ax/core/humanize';
import { fenceLine } from './fence-line.js';

/** What this reader can say about one connector tool namespace. */
export interface ConnectorNaming {
  /** The connector's display name, fenced. */
  name: string;
  /** tool name → the server's cached display title, fenced (TASK-753). */
  tools?: ReadonlyMap<string, string>;
}

/** toolNamespace → naming, as `connectors:tool-labels` returned it for one reader. */
export type ConnectorNames = ReadonlyMap<string, ConnectorNaming>;

/**
 * The wire shape of one namespace (`AgentDetail.connectorTools`), which is
 * also the shape `connectors:tool-labels` answers in — so the host and the
 * browser read it with the same parser, {@link connectorNamesFromRows}.
 */
export interface ConnectorToolsRow {
  toolNamespace: string;
  name: string;
  tools?: Array<{ name: string; title: string }>;
}

/** A host-minted connector tool namespace: `c` + 10 lowercase hex. */
export const CONNECTOR_TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;
const SDK_FORM = /^mcp__(c[0-9a-f]{10})__(.+)$/s;
const KEY_FORM = /^mcp\.(c[0-9a-f]{10})\.(.+)$/s;

/**
 * Bounds on one namespace's cached titles. A tool name is a lookup key only,
 * never rendered; the bound just keeps a hostile server from bloating the wire.
 */
const TOOL_TITLES_MAX_PER_NAMESPACE = 200;
const TOOL_NAME_KEY_MAX_CHARS = 256;

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
  const naming = connectors?.get(parsed.toolNamespace);
  // Never fall through to the caller's raw-name fallback for a connector
  // tool: on the toolKey spelling that fallback would print the hash.
  return (
    composeConnectorToolLabel(naming?.name, parsed.tool, naming?.tools?.get(parsed.tool)) ??
    'Connector tool'
  );
}

/**
 * Parse `connectors:tool-labels` rows (host) or `AgentDetail.connectorTools`
 * rows (browser) into {@link ConnectorNames}. Both are untrusted at this point
 * — the first crossed the bus, the second the network — so every field is
 * checked: a namespace that is not the documented shape is dropped (a key that
 * cannot match anything is noise), names and titles are fenced, and a
 * malformed entry is skipped rather than trusted.
 */
export function connectorNamesFromRows(rows: unknown): ConnectorNames {
  const out = new Map<string, ConnectorNaming>();
  if (!Array.isArray(rows)) return out;
  for (const raw of rows as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as { toolNamespace?: unknown; name?: unknown; tools?: unknown };
    if (typeof row.toolNamespace !== 'string' || !CONNECTOR_TOOL_NAMESPACE_RE.test(row.toolNamespace)) {
      continue;
    }
    const name = typeof row.name === 'string' ? fenceLine(row.name, CONNECTOR_NAME_MAX_CHARS) : null;
    if (name === null) continue;
    const tools = new Map<string, string>();
    if (Array.isArray(row.tools)) {
      for (const t of row.tools as unknown[]) {
        if (tools.size >= TOOL_TITLES_MAX_PER_NAMESPACE) break;
        if (t === null || typeof t !== 'object') continue;
        const { name: toolName, title } = t as { name?: unknown; title?: unknown };
        if (typeof toolName !== 'string' || toolName.length === 0) continue;
        if (toolName.length > TOOL_NAME_KEY_MAX_CHARS || typeof title !== 'string') continue;
        const fenced = fenceLine(title, CONNECTOR_TOOL_PART_MAX_CHARS);
        if (fenced !== null && !tools.has(toolName)) tools.set(toolName, fenced);
      }
    }
    out.set(row.toolNamespace, tools.size > 0 ? { name, tools } : { name });
  }
  return out;
}

/** {@link ConnectorNames} → the `AgentDetail.connectorTools` wire rows. */
export function connectorNamesToRows(names: ConnectorNames): ConnectorToolsRow[] {
  return [...names].map(([toolNamespace, naming]) => ({
    toolNamespace,
    name: naming.name,
    ...(naming.tools !== undefined && naming.tools.size > 0
      ? { tools: [...naming.tools].map(([name, title]) => ({ name, title })) }
      : {}),
  }));
}
