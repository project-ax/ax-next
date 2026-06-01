import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store';
import { requireSession } from '../auth';

/**
 * Offline Vite mock for the connector registry's wire surface
 * (`/admin/connectors[/:id]`).
 *
 * The real backend registers these routes in `@ax/connectors`
 * (`mountAdminRoutes` → `admin-routes.ts`), bridging the `connectors:*` service
 * hooks. The local Vite mock harness has no host bus, so this middleware mirrors
 * the same contract so the registry works under `pnpm dev` with AX_BACKEND_URL
 * unset (TASK-106, followup from TASK-98). The proxy mode (TASK-114) forwards to
 * a real backend instead — a different path.
 *
 * Contract mirrored from `@ax/connectors` `admin-routes.ts` + the client
 * `lib/connectors.ts`:
 *
 *   GET    /admin/connectors      → { connectors: ConnectorSummary[] }
 *   POST   /admin/connectors      body ConnectorUpsertInput → { connector, created }
 *   GET    /admin/connectors/:id  → { connector: Connector }
 *   PATCH  /admin/connectors/:id  body Partial<ConnectorUpsertInput> → { connector, created:false }
 *   DELETE /admin/connectors/:id  → 204
 *
 * Note the path has NO `/api/` prefix (unlike the mock `/api/admin/mcp-servers`)
 * — it matches the real `@ax/connectors` routes, which the UI hits directly.
 *
 * SECURITY parity with the real route:
 *  - `auth:require-user` — ANY authenticated user, NOT admin-only (mock =
 *    `requireSession`; 401 when no session). Connectors are owner-scoped.
 *  - The owner is FORCED from the session, never read from the body — a
 *    client-supplied `userId` is stripped, so a connector can't be created /
 *    read / mutated in a foreign namespace.
 *  - A read/mutate of a connector the actor doesn't own surfaces as 404 (the
 *    foreign connector is simply not found for this user), never 403.
 *  - Responses carry credential SLOT names only (inside `capabilities`), never
 *    secret values — same posture as the hook bus.
 *
 * These type shapes are DUPLICATED from `@ax/connectors` (not imported):
 * channel-web is not a `@ax/connectors` dependency and plugins talk through the
 * hook bus, never via cross-package imports (CLAUDE.md invariant 2). This is the
 * same posture `admin/mcp-servers.ts` keeps for the `@ax/mcp-client` shapes.
 */

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

function toSummary(row: StoredConnector): ConnectorSummary {
  return {
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

function toConnector(row: StoredConnector): Connector {
  return { ...toSummary(row), capabilities: row.capabilities };
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

  const visibility = body.visibility ?? existing?.visibility;
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

export function adminConnectorsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/admin/connectors')) return false;

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

    // ---- collection routes -------------------------------------------------
    if (path === '/admin/connectors' && method === 'GET') {
      const mine = connectors.list().filter((r) => r.userId === actor.id);
      send(res, 200, { connectors: mine.map(toSummary) });
      return true;
    }

    if (path === '/admin/connectors' && method === 'POST') {
      const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
      const result = validateUpsert(body);
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
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      connectors.upsert(row);
      send(res, existing ? 200 : 201, { connector: toConnector(row), created: !existing });
      return true;
    }

    // ---- /admin/connectors/:id ---------------------------------------------
    const idMatch = path.match(/^\/admin\/connectors\/([^/]+)$/);
    if (idMatch && idMatch[1]) {
      const connectorId = decodeURIComponent(idMatch[1]);
      const key = rowKey(actor.id, connectorId);

      if (method === 'GET') {
        const row = connectors.get(key);
        if (!row) {
          send(res, 404, { error: 'not-found' });
          return true;
        }
        send(res, 200, { connector: toConnector(row) });
        return true;
      }

      if (method === 'PATCH') {
        // A PATCH cannot create: the connector must already exist AND be owned by
        // the actor. A foreign / missing connector 404s.
        const existing = connectors.get(key);
        if (!existing) {
          send(res, 404, { error: 'not-found' });
          return true;
        }
        const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
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
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        };
        connectors.upsert(row);
        send(res, 200, { connector: toConnector(row), created: false });
        return true;
      }

      if (method === 'DELETE') {
        const existing = connectors.get(key);
        if (!existing) {
          // Nothing (owned) to delete — surface as 404, same leak posture as a
          // foreign-owned read.
          send(res, 404, { error: 'not-found' });
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
