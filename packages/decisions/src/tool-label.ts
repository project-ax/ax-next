/**
 * A connector tool's name, in words a person can read (TASK-744).
 *
 * Since TASK-734 a connector's MCP tool reaches this gate as the canonical
 * toolKey `mcp.<toolNamespace>.<tool>`, where `<toolNamespace>` is `c` + 10 hex
 * chars — an opaque hash of the connector record. It is the right KEY and the
 * wrong LABEL: printed on an approval card it reads "Wants to run
 * mcp.c5e0235982f.create_issue". This module turns it into "Linear · Create
 * issue", or "Create issue" when the namespace is not one this person can
 * name. The hash itself is never part of the answer.
 *
 * Shape note: the namespace regex is re-stated here rather than imported from
 * `@ax/connectors` (invariant 2). `@ax/connectors`' tests pin a real derived
 * value (`c5e0235982f`); `tool-label.test.ts` pins the same literal so a
 * one-sided shape change is loud.
 *
 * Both halves are untrusted: the tool name comes from a third-party MCP server
 * by way of the model's call, and the connector name was written by whoever
 * authored the connector (a person, or a model for an approved authored one).
 * So both are flattened to one line and clamped here, before they reach a
 * durable row; `templates.ts` re-fences the whole label on its way into prose.
 */

import { replaceSurfaceRewriters } from '@ax/core/surface-text';

/** @ax/connectors' namespace → display-name read (TASK-744). */
export const CONNECTOR_TOOL_LABELS_HOOK = 'connectors:tool-labels';

const CONNECTOR_TOOL_KEY = /^mcp\.(c[0-9a-f]{10})\.(.+)$/s;

/** C0/C1 control characters, written as escapes (a raw byte makes git call the file binary). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

const CONNECTOR_NAME_MAX = 40;
const TOOL_PART_MAX = 48;

function oneLine(value: string, max: number): string {
  const flat = replaceSurfaceRewriters(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const points = [...flat];
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/** `mcp.<ns>.<tool>` → its two parts, or null for any other tool name. */
export function parseConnectorToolKey(
  name: string,
): { toolNamespace: string; tool: string } | null {
  const m = CONNECTOR_TOOL_KEY.exec(name);
  if (m === null) return null;
  return { toolNamespace: m[1]!, tool: m[2]! };
}

/**
 * `create_issue` / `create-issue` / `createIssue` → "Create issue". A display
 * guess, never a key: nothing may decide anything off it.
 */
export function humanizeToolName(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ');
  const flat = oneLine(words, TOOL_PART_MAX);
  if (flat.length === 0) return '';
  const lower = flat === flat.toUpperCase() ? flat : flat.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The friendly label for a connector tool key, or null when `name` is not one
 * (built-in and host tools keep their existing wording).
 *
 * `connectorName` is the display name `connectors:tool-labels` returned for the
 * key's namespace, or null when there was none (unknown namespace, deleted
 * connector, lookup unavailable) — then the tool name stands alone.
 */
export function connectorToolLabel(
  name: string,
  connectorName: string | null,
): string | null {
  const parsed = parseConnectorToolKey(name);
  if (parsed === null) return null;
  const tool = humanizeToolName(parsed.tool);
  const connector =
    connectorName === null ? '' : oneLine(connectorName, CONNECTOR_NAME_MAX);
  if (tool.length === 0) return connector.length > 0 ? connector : null;
  return connector.length > 0 ? `${connector} · ${tool}` : tool;
}
