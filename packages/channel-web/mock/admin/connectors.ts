import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store';
import { requireSession } from '../auth';

/**
 * Offline Vite mock for the connector REST surface. Both route bundles list
 * owned and shared definitions. Only the admin bundle writes (slice 2a); new
 * definitions default to shared. Mirrors the real connectors plugin.
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
 *   POST   <base>      body ConnectorUpsertInput → 201 { connector, created }
 *          (create only: a live id, the caller's own included, is a 409)
 *   GET    <base>/:id  → { connector: Connector }
 *   PATCH  <base>/:id  body Partial<ConnectorUpsertInput> → { connector, created:false }
 *   DELETE <base>/:id  → 204
 *   GET    <base>/:id/tool-permissions[?refresh=1]
 *          → { status, checkedAt, tools: InventoryTool[], defaults: SavedDefault[] }
 *   PUT    <base>/:id/tool-permissions  body { verdicts: [{ toolKey, verdict|null }] }
 *          → { ok: true }   (TASK-737; admin bundle only)
 *   GET    /admin/connectors/authored              → { drafts: ConnectorRequestView[] }
 *   DELETE /admin/connectors/authored/:connectorId → 204
 *          (slice 2c — "Awaiting approval": every person's connector requests;
 *          admin bundle only. A SHARED create clears every request with its id;
 *          the id `authored` is reserved.)
 *
 * Note the path has NO `/api/` prefix — it matches the real `@ax/connectors`
 * routes, which the UI hits directly.
 *
 * SECURITY parity: identity comes from the session. The `/admin/connectors*`
 * bundle is admin-only (403 `forbidden` for a signed-in non-admin, TASK-698);
 * `/settings/connectors*` is READ-ONLY and open to any signed-in user: list +
 * show only. A write on those paths answers 405 (Allow: GET), as production's
 * router does, and `<base>/:id/tool-permissions` has no route there (404).
 * Private foreign rows are
 * invisible; shared foreign rows are read-only. Credential values never appear.
 *
 * These type shapes are DUPLICATED from `@ax/connectors` (not imported):
 * channel-web is not a `@ax/connectors` dependency and plugins talk through the
 * hook bus, never via cross-package imports (CLAUDE.md invariant 2). This is the
 * same posture the other mock middlewares keep for plugin-owned shapes.
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
  transport: 'http';
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

/** Metadata-only descriptor for the list view — omits `capabilities`. */
export interface ConnectorSummary {
  canEdit?: boolean;
  requiresAttachment?: boolean;
  id: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: KeyMode;
  visibility: Visibility;
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
const REQUESTS = 'connector_requests';
/** Mirrors `@ax/connectors` `RESERVED_CONNECTOR_IDS`. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['authored']);

/**
 * An agent's pending request for a connector nobody has defined (slice 2c).
 * Keyed `${owner}::${agent}::${connectorId}`, like the real authored table's
 * (owner, agent, id) key. The proposal is agent-written: stored verbatim.
 */
interface StoredConnectorRequest {
  id: string;
  ownerUserId: string;
  agentId: string;
  connectorId: string;
  name: string;
  usageNote: string;
  keyMode: KeyMode;
  proposal: Capabilities;
  updatedAt: string;
}

/** Test/dev helper: file a request as an agent would (`connector_propose`). */
export function seedConnectorRequest(
  store: Store,
  r: Omit<StoredConnectorRequest, 'id' | 'updatedAt'> & { updatedAt?: string },
): void {
  store.collection<StoredConnectorRequest>(REQUESTS).upsert({
    ...r,
    id: `${r.ownerUserId}::${r.agentId}::${r.connectorId}`,
    updatedAt: r.updatedAt ?? new Date().toISOString(),
  });
}

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
  // The real routes retired the connector `defaultAttached` flag: a body that
  // carries it (any value) is a 400, so a stale client fails loudly.
  if ('defaultAttached' in body) {
    return {
      ok: false,
      message: 'defaultAttached is no longer supported: add connectors to each agent instead',
    };
  }
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

  return {
    ok: true,
    value: { id: connectorId, name, description, usageNote, keyMode, visibility, capabilities },
  };
}

function isReadOnly(row: StoredConnector, actorId: string, mode: RouteMode): boolean {
  return row.userId !== actorId || (mode === 'user' &&
    (row.visibility === 'shared' && row.keyMode === 'workspace'));
}

/** Reject admin-only write fields on the user surface (mirrors the real route's
 *  `rejectAdminOnlyFields`). Returns an error message, else null. */
function rejectAdminOnlyFields(body: Record<string, unknown>): string | null {
  if (body.keyMode === 'workspace') return 'keyMode: workspace is admin-only';
  return null;
}

// ---- tool permissions (TASK-737) -------------------------------------------

type ToolVerdict = 'allow' | 'hold' | 'deny';
const TOOL_VERDICTS: readonly ToolVerdict[] = ['allow', 'hold', 'deny'];
const TOOL_PUT_MAX = 500;

interface InventoryTool {
  toolKey: string;
  name: string;
  title: string;
  description: string;
  readOnly: boolean | null;
  outward: boolean | null;
}

/** A plausible Linear-like inventory. Every remote connector reports it — the
 *  mock has no real server to list tools from. */
const MOCK_TOOLS: Omit<InventoryTool, 'toolKey'>[] = [
  { name: 'search_issues', title: 'Search issues', description: 'Search issues by text, team, or status.', readOnly: true, outward: false },
  { name: 'get_issue', title: 'Read an issue', description: 'Get the details and comments of one issue.', readOnly: true, outward: false },
  { name: 'list_projects', title: 'List projects', description: 'List the projects in your workspace.', readOnly: true, outward: false },
  { name: 'create_issue', title: 'Create issue', description: 'Create a new issue. Teammates are notified.', readOnly: false, outward: true },
  { name: 'update_issue', title: 'Update issue', description: 'Change an issue’s title, status, or assignee.', readOnly: false, outward: false },
  { name: 'delete_issue', title: 'Delete issue', description: 'Delete an issue for everyone.', readOnly: false, outward: true },
];

function mockInventory(connectorId: string): InventoryTool[] {
  return MOCK_TOOLS.map((tool) => ({ ...tool, toolKey: `mcp.${connectorId}.${tool.name}` }));
}

/** In-memory saved defaults, per store: row id → toolKey → verdict. Shared by
 *  the admin and user bundles (same connector, same defaults). */
const toolDefaultsByStore = new WeakMap<Store, Map<string, Map<string, ToolVerdict>>>();

function toolDefaultsFor(store: Store, rowId: string): Map<string, ToolVerdict> {
  let byRow = toolDefaultsByStore.get(store);
  if (!byRow) {
    byRow = new Map();
    toolDefaultsByStore.set(store, byRow);
  }
  let defaults = byRow.get(rowId);
  if (!defaults) {
    defaults = new Map();
    byRow.set(rowId, defaults);
  }
  return defaults;
}

/**
 * The shared connector-routes mock, parameterized by `base` (the bundle's path)
 * and `mode` (`'admin'` = the registry, `'user'` = the read-only /settings bundle). One
 * implementation, two registrations — user mode rejects admin-only fields.
 * Sharing grants read access while mutations stay owner-scoped.
 */
function connectorsMiddleware(
  store: Store,
  opts: { base: string; mode: RouteMode },
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { base, mode } = opts;
  // Escape EVERY regex metacharacter in the base (not just `/`), so the
  // pattern matches the literal prefix whatever it contains.
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const idRe = new RegExp(`^${escapedBase}\\/([^/]+)$`);
  // Slice 2c — the request queue. Admin bundle only; exact paths win over
  // `:id` in production's router, so these are matched first.
  const requestsPath = `${base}/authored`;
  const requestIdRe = new RegExp(`^${escapedBase}\\/authored\\/([^/]+)$`);
  const toolPermsRe = new RegExp(`^${escapedBase}\\/([^/]+)\\/tool-permissions$`);
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith(base)) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    // Only a path shaped like one of this bundle's routes is ours. Production
    // 404s anything else under the prefix (`/admin/connectorsx`, `<base>/a/b`)
    // before any auth gate runs, because no route matches it; claiming it here
    // and answering 401/403 first would disagree with prod (TASK-790).
    const isRequestRoute =
      mode === 'admin' && (path === requestsPath || requestIdRe.test(path));
    if (path !== base && !idRe.test(path) && !toolPermsRe.test(path) && !isRequestRoute)
      return false;
    // Slice 2a: the real `/settings/connectors*` bundle registers list + show
    // only (admins write via `/admin/connectors`). Production's router answers a
    // write on a path a GET shares with 405 before any auth runs, and has no
    // route at all for `<base>/:id/tool-permissions` (404 — fall through).
    if (mode === 'user') {
      if (toolPermsRe.test(path)) return false;
      if (method !== 'GET') {
        send(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET' });
        return true;
      }
    }

    // auth:require-user — 401 with no session. The `/admin/connectors*` bundle
    // (mode 'admin') is additionally ADMIN-ONLY, mirroring the real
    // `@ax/connectors` admin-routes gate (TASK-698): a signed-in non-admin gets
    // 403 `{ error: 'forbidden' }` on every route under it, before any read or
    // write. The `/settings/connectors*` bundle (mode 'user') stays open to any
    // signed-in user. Keeping dev and prod in step means a caller that wrongly
    // points a non-admin at the admin base breaks under `pnpm dev` too (TASK-714).
    const actor = requireSession(req, store);
    if (!actor) {
      send(res, 401, { error: 'unauthenticated' });
      return true;
    }
    if (mode === 'admin' && actor.role !== 'admin') {
      send(res, 403, { error: 'forbidden' });
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
    const requests = store.collection<StoredConnectorRequest>(REQUESTS);
    const clearRequests = (connectorId: string): void => {
      for (const r of requests.list()) if (r.connectorId === connectorId) requests.remove(r.id);
    };

    // ---- /admin/connectors/authored[/:connectorId] (slice 2c) ---------------
    if (isRequestRoute) {
      if (path === requestsPath && method === 'GET') {
        // Ids already live as a shared connector are hidden; one row per
        // (person, id) — the newest of that person's agents' requests.
        const live = new Set(
          connectors.list().filter((c) => c.visibility === 'shared').map((c) => c.connectorId),
        );
        const newest = new Map<string, StoredConnectorRequest>();
        for (const r of requests.list()) {
          if (live.has(r.connectorId)) continue;
          const key = `${r.ownerUserId}\u0000${r.connectorId}`;
          const seen = newest.get(key);
          if (!seen || r.updatedAt > seen.updatedAt) newest.set(key, r);
        }
        const users = store.collection<{ id: string; email?: string; name?: string }>('users');
        const label = (userId: string): string => {
          const u = users.get(userId);
          return u?.name?.trim() || u?.email?.trim() || userId;
        };
        const drafts = [...newest.values()]
          .sort((a, b) =>
            a.connectorId === b.connectorId
              ? a.ownerUserId.localeCompare(b.ownerUserId)
              : a.connectorId.localeCompare(b.connectorId),
          )
          .map((r) => ({
            connectorId: r.connectorId,
            name: r.name,
            usageNote: r.usageNote,
            keyMode: r.keyMode,
            proposal: r.proposal,
            updatedAt: r.updatedAt,
            proposedBy: { userId: r.ownerUserId, label: label(r.ownerUserId) },
          }));
        send(res, 200, { drafts });
        return true;
      }
      const requestMatch = path.match(requestIdRe);
      if (requestMatch?.[1] && method === 'DELETE') {
        clearRequests(decodeURIComponent(requestMatch[1]));
        send(res, 204);
        return true;
      }
      // Any other method falls through to the `:id` routes, as production's
      // router does (`authored` is reserved, so none of them finds a row).
    }

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
      if (typeof body.connectorId === 'string' && RESERVED_IDS.has(body.connectorId)) {
        send(res, 400, { error: `connectorId '${body.connectorId}' is reserved` });
        return true;
      }
      const available = typeof body.connectorId === 'string' ? availableById(body.connectorId) : undefined;
      // Slice 2c — the admin POST is CREATE only, like the real route: any
      // live connector with this id (the caller's own included, any owner, any
      // visibility) is a 409. Edits are a PATCH.
      if (
        mode === 'admin' &&
        connectors.list().some((row) => row.connectorId === body.connectorId)
      ) {
        send(res, 409, { error: 'connector-id-taken' });
        return true;
      }
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
      // Slice 2c — approval is creation: a new SHARED connector resolves every
      // request for its id, whoever asked. A private one resolves nobody's.
      if (!existing && row.visibility === 'shared') clearRequests(row.connectorId);
      send(res, existing ? 200 : 201, { connector: toConnector(row, actor.id), created: !existing });
      return true;
    }

    // ---- <base>/:id/tool-permissions (TASK-737) ----------------------------
    const toolPermsMatch = path.match(toolPermsRe);
    if (toolPermsMatch && toolPermsMatch[1]) {
      const connectorId = decodeURIComponent(toolPermsMatch[1]);
      const row = availableById(connectorId);
      if (!row) {
        send(res, 404, { error: 'not-found' });
        return true;
      }
      // Only someone who can edit the connector can see or set its defaults.
      if (isReadOnly(row, actor.id, mode)) {
        send(res, 403, { error: 'read-only' });
        return true;
      }
      const defaults = toolDefaultsFor(store, row.id);
      if (method === 'GET') {
        const remote = row.capabilities.mcpServers.some((s) => s.transport === 'http');
        send(res, 200, {
          status: remote ? 'ok' : 'unknown',
          checkedAt: remote ? new Date().toISOString() : null,
          tools: remote ? mockInventory(connectorId) : [],
          defaults: [...defaults].map(([toolKey, verdict]) => ({ toolKey, verdict })),
        });
        return true;
      }
      if (method === 'PUT') {
        const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
        const verdicts = body.verdicts;
        if (!Array.isArray(verdicts) || verdicts.length > TOOL_PUT_MAX) {
          send(res, 400, { error: `verdicts must be an array of at most ${TOOL_PUT_MAX} rows` });
          return true;
        }
        const next = new Map(defaults);
        for (const entry of verdicts as Record<string, unknown>[]) {
          const toolKey = entry?.toolKey;
          const verdict = entry?.verdict;
          if (typeof toolKey !== 'string' || toolKey.length === 0 || toolKey.length > 256) {
            send(res, 400, { error: 'toolKey must be a non-empty string' });
            return true;
          }
          if (verdict === null) next.delete(toolKey);
          else if (TOOL_VERDICTS.includes(verdict as ToolVerdict)) next.set(toolKey, verdict as ToolVerdict);
          else {
            send(res, 400, { error: 'verdict must be allow, hold, deny, or null', toolKey });
            return true;
          }
        }
        defaults.clear();
        for (const [k, v] of next) defaults.set(k, v);
        send(res, 200, { ok: true });
        return true;
      }
      return false;
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
        // TASK-827 — whose key a connector uses is fixed once it exists
        // (mirrors the real route). Re-sending the same value is fine.
        if (body.keyMode !== undefined && body.keyMode !== existing.keyMode) {
          send(res, 400, { error: "keyMode can't change on an existing connector" });
          return true;
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

/** The admin Connector registry mock (`/admin/connectors[/:id]`). Admin-only:
 *  a signed-in non-admin gets 403, like the real route (TASK-698). */
export function adminConnectorsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return connectorsMiddleware(store, { base: '/admin/connectors', mode: 'admin' });
}

/** The read-only `/settings/connectors[/:id]` mock (TASK-129; reads only since slice 2a). */
export function settingsConnectorsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return connectorsMiddleware(store, {
    base: '/settings/connectors',
    mode: 'user',
  });
}
