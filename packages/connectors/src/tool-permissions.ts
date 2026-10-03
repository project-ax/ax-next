// ---------------------------------------------------------------------------
// Per-tool default permissions for one connector (TASK-737, connectors rail 4).
//
// The connector editor shows each of a connector's tools with Allow / Ask first
// / Deny. The VALUES live in @ax/tool-policy (one source of truth — this plugin
// never stores a verdict); the tool LIST comes from `connectors:describe-tools`
// (@ax/mcp-client). This module holds the pure parts of the bridge the
// `/…/connectors/:id/tool-permissions` routes run: body validation and the
// "is this key one of THIS connector's tools?" check.
//
// Structural mirrors of the other plugins' hook shapes, re-declared per
// Invariant I2 (no cross-plugin import). The owning plugins validate
// authoritatively — and both answer with `returns` schemas on the bus.
// ---------------------------------------------------------------------------

export type ToolVerdictLike = 'allow' | 'hold' | 'deny';

/** `connectors:describe-tools` (registered by @ax/mcp-client). */
export interface DescribeToolsInputLike {
  userId: string;
  connectorId: string;
  force?: boolean;
}
export interface InventoryToolLike {
  name: string;
  title: string;
  description: string;
  readOnly: boolean | null;
  outward: boolean | null;
  toolKey: string;
}
export interface DescribeToolsOutputLike {
  status: 'ok' | 'unreachable' | 'needs-auth' | 'unknown';
  tools: InventoryToolLike[];
  checkedAt: string;
}

/** `tool-policy:get-connector-defaults` / `set-connector-defaults`. */
export interface GetConnectorDefaultsInputLike {
  connectorId: string;
  toolNamespaces: string[];
}
export interface GetConnectorDefaultsOutputLike {
  defaults: Array<{ toolKey: string; verdict: ToolVerdictLike }>;
}
export interface SetConnectorDefaultsInputLike {
  connectorId: string;
  verdicts: Array<{ toolKey: string; verdict: ToolVerdictLike | null }>;
}
export type SetConnectorDefaultsOutputLike =
  | { ok: true }
  | { ok: false; reason: string; toolKey?: string };

/** `tool-policy:reset-tool-namespaces` (TASK-758). Throws when the reset fails. */
export interface ResetToolNamespacesInputLike {
  toolNamespaces: string[];
}

/**
 * The `PluginError` code `connectors:upsert` throws when an edit points a
 * kept-name server at a new endpoint and its tool permissions could not be
 * reset first (TASK-758). Nothing was saved. The routes answer it as a 503
 * with this exact string as `error`, which is what the editors key their
 * message on.
 */
export const TOOL_PERMISSIONS_RESET_FAILED = 'tool-permissions-reset-failed';

/** Upper bound on rows per save. Mirrors tool-policy's own per-write cap. */
export const MAX_TOOL_PERMISSION_ROWS = 500;

const VERDICTS: ReadonlySet<string> = new Set(['allow', 'hold', 'deny']);

export type ParsedVerdicts =
  | { ok: true; verdicts: Array<{ toolKey: string; verdict: ToolVerdictLike | null }> }
  | { ok: false; error: string; toolKey?: string };

/**
 * Validate a PUT body against the connector's own namespaces.
 *
 * The namespace check is the security-relevant part, not a nicety:
 * `tool-policy:set-connector-defaults` trusts its caller and upserts on
 * `(namespace, tool)` — so without this check, someone who may edit connector
 * A could rewrite connector B's defaults by sending B's tool keys. A key whose
 * namespace is not one of THIS connector's is refused before anything is
 * written (all-or-nothing, like the hook itself).
 */
export function parseToolPermissionsBody(
  raw: unknown,
  ownNamespaces: ReadonlySet<string>,
): ParsedVerdicts {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid-body' };
  }
  const list = (raw as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(list)) return { ok: false, error: 'verdicts must be an array' };
  if (list.length > MAX_TOOL_PERMISSION_ROWS) {
    return { ok: false, error: 'too-many-verdicts' };
  }
  const out: Array<{ toolKey: string; verdict: ToolVerdictLike | null }> = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, error: 'invalid-verdict-row' };
    }
    const { toolKey, verdict } = entry as { toolKey?: unknown; verdict?: unknown };
    if (typeof toolKey !== 'string' || toolKey.length === 0 || toolKey.length > 300) {
      return { ok: false, error: 'invalid-tool-key' };
    }
    const namespace = namespaceOf(toolKey);
    if (namespace === null || !ownNamespaces.has(namespace)) {
      return { ok: false, error: 'not-this-connectors-tool', toolKey };
    }
    if (verdict !== null && (typeof verdict !== 'string' || !VERDICTS.has(verdict))) {
      return { ok: false, error: 'invalid-verdict', toolKey };
    }
    if (seen.has(toolKey)) return { ok: false, error: 'duplicate-tool-key', toolKey };
    seen.add(toolKey);
    out.push({ toolKey, verdict: verdict as ToolVerdictLike | null });
  }
  return { ok: true, verdicts: out };
}

/** `mcp.<ns>.<tool>` → `<ns>`, else null. The tool part must be non-empty. */
function namespaceOf(toolKey: string): string | null {
  if (!toolKey.startsWith('mcp.')) return null;
  const rest = toolKey.slice(4);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return rest.slice(0, dot);
}

/**
 * Keep only inventory rows that belong to this connector and carry the fields
 * the editor renders. Tool text is untrusted third-party prose: we pass it
 * through as data (the UI renders it as text), clamped so a hostile server
 * cannot balloon the response.
 */
export function shapeInventory(
  tools: readonly InventoryToolLike[],
  ownNamespaces: ReadonlySet<string>,
): InventoryToolLike[] {
  const out: InventoryToolLike[] = [];
  for (const t of tools) {
    const ns = namespaceOf(t.toolKey);
    if (ns === null || !ownNamespaces.has(ns)) continue;
    out.push({
      name: t.name.slice(0, 200),
      title: t.title.slice(0, 200),
      description: t.description.slice(0, 1000),
      readOnly: t.readOnly,
      outward: t.outward,
      toolKey: t.toolKey,
    });
    if (out.length >= MAX_TOOL_PERMISSION_ROWS) break;
  }
  return out;
}
