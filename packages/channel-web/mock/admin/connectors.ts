import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store';
import { requireSession } from '../auth';

/**
 * Offline Vite mock for the connector REST surface. Both route bundles list
 * owned and shared definitions; writes stay owner-only. New definitions default
 * to shared with automatic attachment off. User routes reject workspace keys
 * and automatic attachment. Mirrors the real connectors plugin.
 *
 * The real backend registers these routes in `@ax/connectors`
 * (`mountAdminRoutes` → `admin-routes.ts`), bridging the `connectors:*` service
 * hooks. The local Vite mock harness has no host bus, so this middleware mirrors
 * the same contract so the surface works under `pnpm dev` with AX_BACKEND_URL
 * unset (TASK-106, followup from TASK-98). The proxy mode (TASK-114) forwards to
 * a real backend instead — a different path.
 *
 * Contract mirrored from `@ax/connectors` `admin-routes.ts` + the client
 * `lib/connectors.ts` (where `<base>` is the bundle's base path):
 *
 *   GET    <base>      → { connectors: ConnectorSummary[] }
 *   POST   <base>      body ConnectorUpsertInput → { connector, created }
 *   GET    <base>/:id  → { connector: Connector }
 *   PATCH  <base>/:id  body Partial<ConnectorUpsertInput> → { connector, created:false }
 *   DELETE <base>/:id  → 204
 *
 * Note the path has NO `/api/` prefix (unlike the mock `/api/admin/mcp-servers`)
 * — it matches the real `@ax/connectors` routes, which the UI hits directly.
 *
 * SECURITY parity: identity comes from the session. Private foreign rows are
 * invisible; shared foreign rows are read-only. Credential values never appear.
 *
 * These type shapes are DUPLICATED from `@ax/connectors` (not imported):
 * channel-web is not a `@ax/connectors` dependency and plugins talk through the
 * hook bus, never via cross-package imports (CLAUDE.md invariant 2). This is the
 * same posture `admin/mcp-servers.ts` keeps for the `@ax/mcp-client` shapes.
 */

/** Which route bundle a mock middleware serves (mirrors the client base). */
type RouteMode = 'admin' | 'user';

type KeyMode = 'personal' | 'workspace';
type Visibility = 'private' | 'shared';

interface CapabilitySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
  account?: string;
}

interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  allowedHosts: string[];
  credentials: CapabilitySlot[];
}

interface Capabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
  mcpServers: McpServerSpec[];
  packages: { npm: string[]; pypi: string[] };
}

/** Metadata-only descriptor for the list view — omits `capabilities`.
 *  `defaultAttached` is the admin workspace-default flag, on the summary
 *  (TASK-110) so the user list can badge a default-on connector as "Catalog". */
export interface ConnectorSummary {
  canEdit?: boolean;
  requiresAttachment?: boolean;
  id: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: KeyMode;
  visibility: Visibility;
  defaultAttached: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The full connector, including the opaque capability fill. */
export interface Connector extends ConnectorSummary {
  capabilities: Capabilities;
}

/**
 * The stored row. The mock `Store` keys a collection by `id`, but connectors are
 * owner-scoped and two users may each own the same slug — so the row `id` is the
 * composite `${userId}::${connectorId}`. The connector's own slug + owner ride as
 * separate fields and never leak into the wire shape.
 */
interface StoredConnector extends Connector {
  /** Composite store key: `${userId}::${connectorId}`. */
  id: string;
  userId: string;
  connectorId: string;
}

const ID_MAX = 128;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 200;

const COLLECTION = 'connectors';

function rowKey(userId: string, connectorId: string): string {
  return `${userId}::${connectorId}`;
}

function emptyCapabilities(): Capabilities {
  return { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };
}

function toSummary(row: StoredConnector, actorId: string): ConnectorSummary {
  return {
    canEdit: row.userId === actorId,
    requiresAttachment: row.requiresAttachment ?? false,
    id: row.connectorId,
    name: row.name,
    description: row.description,
    usageNote: row.usageNote,
    keyMode: row.keyMode,
    visibility: row.visibility,
    defaultAttached: row.defaultAttached,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConnector(row: StoredConnector, actorId: string): Connector {
  return { ...toSummary(row, actorId), capabilities: row.capabilities };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  res.statusCode = status;
  if (body === undefined) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

type Validated =
  | { ok: true; value: Omit<Connector, 'createdAt' | 'updatedAt'> }
  | { ok: false; message: string };

/**
 * Lightweight validation mirroring the SHAPE the real `connectors:upsert` hook
 * enforces (slug grammar + required name/keyMode/visibility). The mock does NOT
 * re-implement the full zod capability parse — it stores `capabilities` verbatim
 * (defaulting to empty) because the mock is offline UI parity and the real route
 * owns strict validation. `existing` supplies merge defaults for a PATCH.
 */
function validateUpsert(
  body: Record<string, unknown>,
  existing?: StoredConnector,
): Validated {
  const connectorId = body.connectorId ?? existing?.connectorId;
  if (typeof connectorId !== 'string' || connectorId.length === 0 || connectorId.length > ID_MAX) {
    return { ok: false, message: `connectorId must be 1-${ID_MAX} chars` };
  }
  if (!ID_RE.test(connectorId)) {
    return { ok: false, message: `connectorId must match ${ID_RE.source} (lowercase slug)` };
  }

  const name = body.name ?? existing?.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    return { ok: false, message: `name must be 1-${NAME_MAX} chars` };
  }

  const keyMode = body.keyMode ?? existing?.keyMode;
  if (keyMode !== 'personal' && keyMode !== 'workspace') {
    return { ok: false, message: "keyMode must be 'personal' or 'workspace'" };
  }

  const visibility = body.visibility ?? existing?.visibility ?? 'shared';
  if (visibility !== 'private' && visibility !== 'shared') {
    return { ok: false, message: "visibility must be 'private' or 'shared'" };
  }

  const description = body.description ?? existing?.description ?? '';
  const usageNote = body.usageNote ?? existing?.usageNote ?? '';
  if (typeof description !== 'string' || typeof usageNote !== 'string') {
    return { ok: false, message: 'description / usageNote must be strings if provided' };
  }

  const capabilities = (body.capabilities ?? existing?.capabilities ?? emptyCapabilities()) as Capabilities;
  const defaultAttached =
    typeof body.defaultAttached === 'boolean'
      ? body.defaultAttached
      : (existing?.defaultAttached ?? false);

  return {
    ok: true,
    value: { id: connectorId, name, description, usageNote, keyMode, visibility, capabilities, defaultAttached },
  };
}

function isReadOnly(row: StoredConnector, actorId: string, mode: RouteMode): boolean {
  return row.userId !== actorId || (mode === 'user' &&
    (row.defaultAttached || (row.visibility === 'shared' && row.keyMode === 'workspace')));
}

/** Reject admin-only write fields on the user surface (mirrors the real route's
 *  `rejectAdminOnlyFields`). Returns an error message, else null. */
function rejectAdminOnlyFields(body: Record<string, unknown>): string | null {
  if (body.keyMode === 'workspace') return 'keyMode: workspace is admin-only';
  if (body.defaultAttached === true) return 'defaultAttached is admin-only';
  return null;
}

/**
 * The shared connector-routes mock, parameterized by `base` (the bundle's path)
 * and `mode` (`'admin'` = the registry, `'user'` = locked-down authoring). One
 * implementation, two registrations — user mode rejects admin-only fields.
 * Sharing grants read access while mutations stay owner-scoped.
 */
function connectorsMiddleware(
  store: Store,
  opts: { base: string; mode: RouteMode },
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { base, mode } = opts;
  const idRe = new RegExp(`^${base.replace(/[/]/g, '\\/')}\\/([^/]+)$`);
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith(base)) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    // auth:require-user — any authenticated user (NOT admin-only).
    const actor = requireSession(req, store);
    if (!actor) {
      send(res, 401, { error: 'unauthenticated' });
      return true;
    }

    const connectors = store.collection<StoredConnector>(COLLECTION);

    const availableRows = () => {
      const grouped = new Map<string, StoredConnector[]>();
      for (const row of connectors.list()) {
        if (row.userId !== actor.id && row.visibility !== 'shared') continue;
        const group = grouped.get(row.connectorId) ?? [];
        group.push(row);
        grouped.set(row.connectorId, group);
      }
      return [...grouped.values()].flatMap((rows) => {
        const own = rows.find((row) => row.userId === actor.id);
        return own ? [own] : rows.length === 1 ? rows : [];
      });
    };
    const availableById = (id: string) => availableRows().find((row) => row.connectorId === id);

    // ---- collection routes -------------------------------------------------
    if (path === base && method === 'GET') {
      send(res, 200, { connectors: availableRows().map((row) => toSummary(row, actor.id)) });
      return true;
    }

    if (path === base && method === 'POST') {
      const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
      if (mode === 'user') {
        const rejected = rejectAdminOnlyFields(body);
        if (rejected !== null) {
          send(res, 400, { error: rejected });
          return true;
        }
      }
      const available = typeof body.connectorId === 'string' ? availableById(body.connectorId) : undefined;
      if (available && isReadOnly(available, actor.id, mode)) {
        send(res, 403, { error: 'read-only' });
        return true;
      }
      const result = validateUpsert(body, available);
      if (!result.ok) {
        send(res, 400, { error: result.message });
        return true;
      }
      const key = rowKey(actor.id, result.value.id);
      const existing = connectors.get(key);
      const now = new Date().toISOString();
      const row: StoredConnector = {
        ...result.value,
        // Composite store key + owner forced from the session — a body-supplied
        // userId never reaches here, so a client cannot owner-hijack.
        id: key,
        userId: actor.id,
        connectorId: result.value.id,
        requiresAttachment: existing?.requiresAttachment ?? !existing,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      connectors.upsert(row);
      send(res, existing ? 200 : 201, { connector: toConnector(row, actor.id), created: !existing });
      return true;
    }

    // ---- <base>/:id --------------------------------------------------------
    const idMatch = path.match(idRe);
    if (idMatch && idMatch[1]) {
      const connectorId = decodeURIComponent(idMatch[1]);
      const key = rowKey(actor.id, connectorId);

      if (method === 'GET') {
        const row = availableById(connectorId);
        if (!row) {
          send(res, 404, { error: 'not-found' });
          return true;
        }
        send(res, 200, { connector: toConnector(row, actor.id) });
        return true;
      }

      if (method === 'PATCH') {
        // A PATCH cannot create: the connector must already exist AND be owned by
        // the actor. A foreign / missing connector 404s.
        const existing = availableById(connectorId);
        if (!existing) {
          send(res, 404, { error: 'not-found' });
          return true;
        }
        // User-authoring surface: a catalog/shared connector is read-only (403).
        if (isReadOnly(existing, actor.id, mode)) {
          send(res, 403, { error: 'read-only' });
          return true;
        }
        const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
        if (mode === 'user') {
          const rejected = rejectAdminOnlyFields(body);
          if (rejected !== null) {
            send(res, 400, { error: rejected });
            return true;
          }
        }
        const result = validateUpsert(body, existing);
        if (!result.ok) {
          send(res, 400, { error: result.message });
          return true;
        }
        // Re-assert the immutable identity + owner from the URL / session — the
        // URL slug is authoritative, so a body field can't rename or hijack.
        const row: StoredConnector = {
          ...result.value,
          id: key,
          userId: actor.id,
          connectorId,
          requiresAttachment: existing.requiresAttachment ?? false,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        };
        connectors.upsert(row);
        send(res, 200, { connector: toConnector(row, actor.id), created: false });
        return true;
      }

      if (method === 'DELETE') {
        const existing = availableById(connectorId);
        if (!existing) {
          // Nothing (owned) to delete — surface as 404, same leak posture as a
          // foreign-owned read.
          send(res, 404, { error: 'not-found' });
          return true;
        }
        // User-authoring surface: a catalog/shared connector is read-only (403).
        if (isReadOnly(existing, actor.id, mode)) {
          send(res, 403, { error: 'read-only' });
          return true;
        }
        connectors.remove(key);
        send(res, 204);
        return true;
      }
    }

    return false;
  };
}

/** The admin Connector registry mock (`/admin/connectors[/:id]`). */
export function adminConnectorsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return connectorsMiddleware(store, { base: '/admin/connectors', mode: 'admin' });
}

/** The user-authoring mock (`/settings/connectors[/:id]`, TASK-129). */
export function settingsConnectorsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return connectorsMiddleware(store, {
    base: '/settings/connectors',
    mode: 'user',
  });
}
