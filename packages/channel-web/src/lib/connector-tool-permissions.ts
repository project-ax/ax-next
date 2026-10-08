/**
 * Per-tool default permissions for a connector (TASK-737) — typed client +
 * pure helpers for the connector editor's "Tool permissions" section.
 *
 *   GET <base>/:id/tool-permissions[?refresh=1]
 *     → { status, checkedAt, tools: InventoryTool[], defaults: SavedDefault[] }
 *   PUT <base>/:id/tool-permissions  body { verdicts: [{ toolKey, verdict|null }] }
 *     → { ok: true }
 *
 * `base` is always `/admin/connectors`: these routes exist only on the admin
 * bundle, and their one client is the admin connector editor.
 *
 * SECURITY — a tool's `title` / `description` come from the third-party server
 * and are UNTRUSTED. They are rendered as plain text only, and the description
 * is clamped (`clampDescription`) before it ever reaches the DOM.
 */
import type { ConnectorWriteBase } from './connectors';

/** Allow = runs on its own; hold = asks first; deny = never runs. */
export type ToolVerdict = 'allow' | 'hold' | 'deny';

export interface InventoryTool {
  toolKey: string;
  name: string;
  title: string;
  description: string;
  readOnly: boolean | null;
  outward: boolean | null;
}

export interface SavedDefault {
  toolKey: string;
  verdict: ToolVerdict;
}

export type InventoryStatus = 'ok' | 'unreachable' | 'needs-auth' | 'unknown';

export interface ToolPermissions {
  status: InventoryStatus;
  checkedAt: string | null;
  tools: InventoryTool[];
  defaults: SavedDefault[];
}

export interface VerdictChange {
  toolKey: string;
  verdict: ToolVerdict | null;
}

/** Carries the HTTP status so the UI can tell "you can't edit this" (403)
 *  from "something went wrong". */
export class ToolPermissionsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ToolPermissionsError';
  }
}

export const PUT_MAX = 500;

const VERDICTS: readonly ToolVerdict[] = ['allow', 'hold', 'deny'];
const STATUSES: readonly InventoryStatus[] = [
  'ok',
  'unreachable',
  'needs-auth',
  'unknown',
];

function path(id: string, base: ConnectorWriteBase): string {
  return `${base}/${encodeURIComponent(id)}/tool-permissions`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Normalise the wire body defensively — a malformed row is dropped rather
 *  than trusted. */
function parse(body: unknown): ToolPermissions {
  const raw = (body ?? {}) as Record<string, unknown>;
  const status = STATUSES.includes(raw.status as InventoryStatus)
    ? (raw.status as InventoryStatus)
    : 'unknown';
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).flatMap(
    (t): InventoryTool[] => {
      const r = (t ?? {}) as Record<string, unknown>;
      const toolKey = str(r.toolKey);
      if (!toolKey) return [];
      return [
        {
          toolKey,
          name: str(r.name),
          title: str(r.title),
          description: str(r.description),
          readOnly: tri(r.readOnly),
          outward: tri(r.outward),
        },
      ];
    },
  );
  const defaults = (Array.isArray(raw.defaults) ? raw.defaults : []).flatMap(
    (d): SavedDefault[] => {
      const r = (d ?? {}) as Record<string, unknown>;
      const toolKey = str(r.toolKey);
      const verdict = r.verdict as ToolVerdict;
      return toolKey && VERDICTS.includes(verdict) ? [{ toolKey, verdict }] : [];
    },
  );
  return {
    status,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
    tools,
    defaults,
  };
}

export async function getToolPermissions(
  id: string,
  base: ConnectorWriteBase,
  opts: { refresh?: boolean } = {},
): Promise<ToolPermissions> {
  const res = await fetch(`${path(id, base)}${opts.refresh ? '?refresh=1' : ''}`, {
    credentials: 'include',
  });
  if (!res.ok)
    throw new ToolPermissionsError(`get tool permissions: ${res.status}`, res.status);
  return parse(await res.json());
}

export async function putToolPermissions(
  id: string,
  base: ConnectorWriteBase,
  verdicts: VerdictChange[],
): Promise<void> {
  // The server takes at most PUT_MAX rows per request.
  for (let i = 0; i < verdicts.length; i += PUT_MAX) {
    const res = await fetch(path(id, base), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'ax-admin',
      },
      credentials: 'include',
      body: JSON.stringify({ verdicts: verdicts.slice(i, i + PUT_MAX) }),
    });
    if (!res.ok)
      throw new ToolPermissionsError(`put tool permissions: ${res.status}`, res.status);
  }
}

/** With no saved default, a tool that only looks things up is allowed; anything
 *  else asks first. */
export function prefillVerdict(tool: Pick<InventoryTool, 'readOnly'>): ToolVerdict {
  return tool.readOnly === true ? 'allow' : 'hold';
}

/** The display name for a tool key we only know from a saved default: the part
 *  after the second dot (`<kind>.<connector>.<tool>`), else the whole key. */
export function titleFromToolKey(toolKey: string): string {
  const parts = toolKey.split('.');
  return parts.length > 2 ? parts.slice(2).join('.') : toolKey;
}

export const DESCRIPTION_MAX = 300;

/** Clamp an untrusted description to a readable length. */
export function clampDescription(text: string, max = DESCRIPTION_MAX): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/** Every tool the section shows: the inventory, plus saved defaults for tools
 *  the inventory doesn't (or can't) list, so those stay editable. */
export function toolRows(perms: ToolPermissions): InventoryTool[] {
  const known = new Set(perms.tools.map((t) => t.toolKey));
  const orphans = perms.defaults
    .filter((d) => !known.has(d.toolKey))
    .map((d) => ({
      toolKey: d.toolKey,
      name: '',
      title: titleFromToolKey(d.toolKey),
      description: '',
      readOnly: null,
      outward: null,
    }));
  return [...perms.tools, ...orphans];
}

/** Saved defaults, keyed by tool. */
export function savedVerdicts(perms: ToolPermissions): Map<string, ToolVerdict> {
  return new Map(perms.defaults.map((d) => [d.toolKey, d.verdict]));
}

/** What each row starts on: the saved default wins, else the prefill. */
export function initialVerdicts(perms: ToolPermissions): Map<string, ToolVerdict> {
  const out = new Map<string, ToolVerdict>();
  for (const tool of perms.tools) out.set(tool.toolKey, prefillVerdict(tool));
  for (const d of perms.defaults) out.set(d.toolKey, d.verdict);
  return out;
}

export interface ToolGroups {
  /** readOnly === true */
  looksUp: InventoryTool[];
  /** Everything else, including tools whose behaviour we don't know. */
  makesChanges: InventoryTool[];
}

export function groupTools(tools: InventoryTool[]): ToolGroups {
  return {
    looksUp: tools.filter((t) => t.readOnly === true),
    makesChanges: tools.filter((t) => t.readOnly !== true),
  };
}

/** Rows whose current verdict differs from the SAVED default. An unsaved
 *  prefill has no saved default, so it counts as a change. A saved default with
 *  no current verdict is cleared (`null`). */
export function changedRows(
  saved: ReadonlyMap<string, ToolVerdict>,
  current: ReadonlyMap<string, ToolVerdict>,
): VerdictChange[] {
  const out: VerdictChange[] = [];
  for (const [toolKey, verdict] of current)
    if (saved.get(toolKey) !== verdict) out.push({ toolKey, verdict });
  for (const toolKey of saved.keys())
    if (!current.has(toolKey)) out.push({ toolKey, verdict: null });
  return out;
}
