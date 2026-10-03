/**
 * A connector tool's name, in words a person can read (TASK-744, TASK-753).
 *
 * Since TASK-734 a connector's MCP tool reaches this gate as the canonical
 * toolKey `mcp.<toolNamespace>.<tool>`, where `<toolNamespace>` is `c` + 10 hex
 * chars — an opaque hash of the connector record. It is the right KEY and the
 * wrong LABEL: printed on an approval card it reads "Wants to run
 * mcp.c5e0235982f.create_issue". This module turns it into "Linear · Create
 * issue" — or the MCP server's own cached title for the tool when one is known,
 * or the tool alone when the namespace is not one this person can name. The
 * hash itself is never part of the answer.
 *
 * The label itself is composed by `@ax/core/humanize`'s `connectorToolLabel`,
 * the SAME function channel-web uses for the activity rail and the transcript,
 * so one call reads the same on all three surfaces (TASK-753: this module used
 * to carry its own humanizer, and the card said "Create pdf" beside an activity
 * row that said "Create PDF").
 *
 * Shape note: the namespace regex is re-stated here rather than imported from
 * `@ax/connectors` (invariant 2). `@ax/connectors`' tests pin a real derived
 * value (`c5e0235982f`); `tool-label.test.ts` pins the same literal so a
 * one-sided shape change is loud.
 *
 * Every input is untrusted: the tool name comes from a third-party MCP server
 * by way of the model's call, the title from that same server, and the
 * connector name was written by whoever authored the connector. The core
 * composer fences and clamps each half before it reaches a durable row;
 * `templates.ts` re-fences the whole label on its way into prose.
 */

import { connectorToolLabel as composeConnectorToolLabel } from '@ax/core/humanize';

/** @ax/connectors' namespace → display-name read (TASK-744). */
export const CONNECTOR_TOOL_LABELS_HOOK = 'connectors:tool-labels';

const CONNECTOR_TOOL_KEY = /^mcp\.(c[0-9a-f]{10})\.(.+)$/s;

/** `mcp.<ns>.<tool>` → its two parts, or null for any other tool name. */
export function parseConnectorToolKey(
  name: string,
): { toolNamespace: string; tool: string } | null {
  const m = CONNECTOR_TOOL_KEY.exec(name);
  if (m === null) return null;
  return { toolNamespace: m[1]!, tool: m[2]! };
}

/**
 * What `connectors:tool-labels` could say about one held connector tool: the
 * connector's display name and the server's cached title for the tool, each
 * null when unknown.
 */
export interface ConnectorToolNaming {
  connectorName: string | null;
  toolTitle: string | null;
}

/**
 * The friendly label for a connector tool key, or null when `name` is not one
 * (built-in and host tools keep their existing wording) or nothing legible is
 * left of it.
 *
 * `connectorName` is the display name `connectors:tool-labels` returned for the
 * key's namespace, or null when there was none (unknown namespace, deleted
 * connector, lookup unavailable) — then the tool stands alone. `toolTitle` is
 * the server's cached title for the tool, preferred over the humanized name
 * when present.
 */
export function connectorToolLabel(
  name: string,
  connectorName: string | null,
  toolTitle: string | null = null,
): string | null {
  const parsed = parseConnectorToolKey(name);
  if (parsed === null) return null;
  return composeConnectorToolLabel(connectorName, parsed.tool, toolTitle);
}

/**
 * Pick one held tool's naming out of a `connectors:tool-labels` answer. The
 * answer is duck-typed (invariant 2) and arrives over the bus, so every field
 * is checked rather than trusted; a malformed entry names nothing.
 */
export function namingFromToolLabels(
  out: unknown,
  toolNamespace: string,
  tool: string,
): ConnectorToolNaming {
  const connectors = (out as { connectors?: unknown } | null | undefined)?.connectors;
  if (!Array.isArray(connectors)) return { connectorName: null, toolTitle: null };
  for (const entry of connectors as unknown[]) {
    const c = entry as { toolNamespace?: unknown; name?: unknown; tools?: unknown } | null;
    if (c === null || typeof c !== 'object' || c.toolNamespace !== toolNamespace) continue;
    let toolTitle: string | null = null;
    if (Array.isArray(c.tools)) {
      for (const t of c.tools as unknown[]) {
        const tt = t as { name?: unknown; title?: unknown } | null;
        if (tt !== null && typeof tt === 'object' && tt.name === tool && typeof tt.title === 'string') {
          toolTitle = tt.title;
          break;
        }
      }
    }
    return { connectorName: typeof c.name === 'string' ? c.name : null, toolTitle };
  }
  return { connectorName: null, toolTitle: null };
}
