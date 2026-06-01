import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import type {
  Connector,
  ConnectorSummary,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetOutput,
  ListInput,
  ListOutput,
  UpsertInput,
  UpsertOutput,
} from './types.js';
import { deriveCredentialPlan } from './credential-plan.js';

// ---------------------------------------------------------------------------
// HTTP route handlers for /admin/connectors[/:id].
//
// This is the connector registry's wire surface — channel-web's admin UI hits
// real `/admin/*` HTTP routes (it never reaches the bus directly), so the
// registry needs an HTTP bridge over the `connectors:*` service hooks. Mirrors
// the @ax/mcp-client / @ax/agents admin-route pattern: handlers DUCK-TYPE the
// http-server's req/res surface (Invariant I2 — no @ax/http-server import) and
// delegate to the existing `connectors:{list,get,upsert,delete}` hooks for
// validation + persistence (Invariant I4 — the connector store stays the one
// source of truth).
//
// Mechanism-agnostic (Invariant I1): no `transport` / `command` / `url` / `mcp`
// appears as a first-class route field. The backing-mechanism vocabulary rides
// ONLY inside the opaque `capabilities` object in request/response bodies — the
// same posture the bus hooks keep.
//
// All endpoints require auth:require-user (401 on miss). Connectors are
// owner-scoped by the calling user's id — the actor id is forced from the
// authenticated session, never read from the client body, so a client can never
// create / read / mutate a connector in a foreign namespace. A read or mutate of
// a connector the actor doesn't own surfaces as 404 (the connector store scopes
// by userId, so a foreign connector is simply not found for this user).
//
// Responses NEVER include resolved credential VALUES — a connector declares
// credential SLOT names only (the `capabilities.credentials[].slot`); the actual
// secret resolves at proxy time inside the sandbox and never touches a response.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/connectors';

/** 64 KiB cap on request bodies. Mirrors @ax/mcp-client / @ax/agents — wide
 *  enough for a full connector with its capabilities spec but smaller than the
 *  http-server's 1 MiB cap so the admin API doesn't accept blobs the storage
 *  layer can't sanely hold. */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import) -------------------------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/admin/connectors/:id`. */
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

// --- helpers --------------------------------------------------------------

async function requireUser(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<{ id: string; isAdmin: boolean } | null> {
  try {
    const result = await bus.call<
      { req: RouteRequest },
      { user: { id: string; isAdmin: boolean } }
    >('auth:require-user', ctx, { req });
    return { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

interface ParsedBody<T> {
  ok: true;
  value: T;
}
interface ParseError {
  ok: false;
  status: 400 | 413;
  message: string;
}

function parseAndValidateBody(body: Buffer): ParsedBody<unknown> | ParseError {
  if (body.length > ADMIN_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}

/**
 * Map a thrown PluginError from a `connectors:*` hook to an HTTP status. The
 * hooks throw structured codes (`invalid-payload`, `not-found`); everything
 * else bubbles as a 500 (re-thrown). We collapse the message — never echo
 * internal stack/field detail beyond the hook's own message string.
 */
function handleHookError(err: unknown, res: RouteResponse): void {
  if (err instanceof PluginError) {
    if (err.code === 'not-found') {
      res.status(404).json({ error: 'not-found' });
      return;
    }
    if (err.code === 'invalid-payload') {
      res.status(400).json({ error: err.message });
      return;
    }
  }
  throw err;
}

// --- connector Test probe (TASK-108) --------------------------------------
//
// The connector equivalent of the old McpServerForm `/test`. The deleted MCP
// form opened a REAL outbound MCP connection; a connector's backing mechanism
// is deliberately hidden (a connector may be MCP, a CLI/package, or a direct
// API), so a connector-level probe stays at the right altitude: it reports
// whether the connector is set up to work, WITHOUT opening any network
// connection. Two checks, both derivable from data the connectors plugin
// already owns plus a metadata-only credential read:
//
//   needs-key   — a declared credential slot has no key in the vault yet
//                 (`credentials:list` is metadata-only — it NEVER returns a
//                 secret value; we only check whether a row at the derived
//                 `(scope, ref)` exists).
//   unreachable — the config is malformed: an MCP-backed connector whose
//                 leading server declares neither a `url` (http) nor a
//                 `command` (stdio), so it can't connect to anything.
//   reachable   — required slots filled + config sane (covers CLI/package and
//                 direct-API connectors, which need only slot presence).
//
// I1: the verdict (`reachable`/`unreachable`/`needs-key`) is a neutral status —
// no `transport`/`url`/`pod`/`sha` leaks into it. I2: credential presence is
// read over the EXISTING `credentials:list` bus hook — no @ax/credentials or
// @ax/mcp-client runtime import. I5: metadata-only (no `credentials:get`, no
// secret values reach the probe). A real outbound-connection probe (what the
// old MCP /test did) is a deferred follow-up — it would need a new host-side
// network-egress hook + untrusted-remote-response handling.

export type ProbeStatus = 'reachable' | 'unreachable' | 'needs-key';

export interface ProbeResult {
  status: ProbeStatus;
  /** Optional human-readable hint (e.g. the first unfilled slot). Neutral —
   *  never echoes a secret or a backend-specific identifier. */
  detail?: string;
}

/** Minimal shape of a `credentials:list` row we read — METADATA ONLY. The
 *  full @ax/credentials `CredentialMeta` carries more, but the probe only needs
 *  `(scope, ref)` to decide presence; we never touch a value. */
interface CredentialMetaLike {
  scope: string;
  ownerId: string | null;
  ref: string;
}

/**
 * Probe a connector for setup-completeness. Owner-scoped: `actorId` is the
 * authenticated caller, used to look up `scope:'user'` (personal) keys in the
 * caller's own vault; `scope:'global'` (workspace) keys live under `ownerId:null`.
 *
 * Returns `needs-key` the moment a required slot has no key, otherwise checks
 * config sanity, otherwise `reachable`. Never throws on a missing credential —
 * a `credentials:list` failure is folded into a conservative `unreachable`.
 */
export async function probeConnector(
  connector: Connector,
  deps: { bus: HookBus; ctx: AgentContext; actorId: string },
): Promise<ProbeResult> {
  const plan = deriveCredentialPlan(connector);
  for (const entry of plan) {
    // `scope:'user'` keys are owned by the caller; `scope:'global'` (workspace)
    // keys live under ownerId:null. The credential store scopes its read by
    // (scope, ownerId) — we then check the derived ref is present.
    const ownerId = entry.scope === 'global' ? null : deps.actorId;
    let rows: CredentialMetaLike[];
    try {
      const out = await deps.bus.call<
        { scope: string; ownerId: string | null },
        { credentials: CredentialMetaLike[] }
      >('credentials:list', deps.ctx, { scope: entry.scope, ownerId });
      rows = out.credentials;
    } catch {
      // A read failure can't prove the key exists — conservatively report the
      // connector as not-yet-usable rather than a false "reachable".
      return { status: 'unreachable', detail: 'could not verify credentials' };
    }
    const present = rows.some((r) => r.ref === entry.ref && r.scope === entry.scope);
    if (!present) {
      return { status: 'needs-key', detail: `missing key for slot "${entry.slot}"` };
    }
  }

  // Config sanity: an MCP-backed connector must give its leading server a way to
  // reach something — an http `url` or a stdio `command`. A connector with no
  // mcpServers is CLI/package/direct-API backed and passes this check (its reach
  // is the allowedHosts + the now-verified slots).
  const leadServer = connector.capabilities.mcpServers[0];
  if (leadServer !== undefined) {
    const hasUrl = typeof leadServer.url === 'string' && leadServer.url.trim().length > 0;
    const hasCommand =
      typeof leadServer.command === 'string' && leadServer.command.trim().length > 0;
    if (!hasUrl && !hasCommand) {
      return { status: 'unreachable', detail: 'MCP server has no url or command' };
    }
  }

  return { status: 'reachable' };
}

// --- handler factory ------------------------------------------------------

export interface AdminRouteDeps {
  bus: HookBus;
}

/**
 * The route bundle's authoring MODE — the policy difference between the admin
 * Connector registry and the user-authoring surface (TASK-129).
 *
 *   - `'admin'` — the folded Connector registry (`/admin/connectors`). The actor
 *     may curate the workspace catalog: set `visibility: 'shared'` and
 *     `defaultAttached: true`. Owner is still forced from the session.
 *   - `'user'`  — user authoring (`/settings/connectors`). The actor may only
 *     ever create/edit their OWN PRIVATE connectors. Admin-only fields
 *     (`visibility: 'shared'`, `defaultAttached: true`) are REJECTED server-side
 *     (400 — not silently dropped), `visibility` is forced `'private'`, and a
 *     catalog/shared connector (one already `shared`/default-on) is READ-ONLY:
 *     editing or deleting it through the user surface 403s. This is the
 *     server-side enforcement of "catalog/shared connectors are read-only for
 *     non-admins" — never UI-only.
 *
 * Both modes share the read paths (list/show) and the owner-forced-from-session
 * posture verbatim; mode only gates the write policy. There is NO role gate on
 * the user routes — any authenticated user may author their own private
 * connectors (the human is the granting authority for their own agents; no
 * approval wall is on this path — that gates MODEL-authored reach only).
 */
export type ConnectorRouteMode = 'admin' | 'user';

/** A catalog/shared connector — admin-curated, hence read-only for a non-admin
 *  author. Mirrors channel-web's `connectorSource(...) === 'catalog'`. */
function isCatalogConnector(c: Connector): boolean {
  return c.visibility === 'shared' || c.defaultAttached === true;
}

/**
 * Reject admin-only write fields on the user surface. Returns an error message
 * when the body carries a field only an admin may set (so the route 400s instead
 * of silently downgrading), else null. Checked BEFORE the owner/visibility are
 * forced so a tampered client body surfaces as a clear rejection.
 */
function rejectAdminOnlyFields(raw: Record<string, unknown>): string | null {
  if (raw.visibility === 'shared') {
    return 'visibility: shared is admin-only';
  }
  if (raw.defaultAttached === true) {
    return 'defaultAttached is admin-only';
  }
  return null;
}

export function createConnectorRouteHandlers(
  deps: AdminRouteDeps & { mode?: ConnectorRouteMode },
) {
  const mode: ConnectorRouteMode = deps.mode ?? 'admin';
  // Per-handler-bundle ctx mirrors the @ax/mcp-client / @ax/agents pattern. The
  // synthetic ctx attributes the bus calls; the real actor id flows through the
  // hook input (`userId`), forced from the authenticated session below.
  const ctx = makeAgentContext({
    sessionId: `connectors-${mode}`,
    agentId: PLUGIN_NAME,
    userId: mode,
  });

  return {
    /** GET /admin/connectors */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const out = await deps.bus.call<ListInput, ListOutput>(
        'connectors:list',
        ctx,
        { userId: actor.id },
      );
      res.status(200).json({ connectors: out.connectors satisfies ConnectorSummary[] });
    },

    /** GET /admin/connectors/:id */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      try {
        const out = await deps.bus.call<GetInput, GetOutput>(
          'connectors:get',
          ctx,
          { userId: actor.id, connectorId: id },
        );
        res.status(200).json({ connector: out.connector satisfies Connector });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /** POST /admin/connectors — create (or update an owned connector). */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const parsed = parseAndValidateBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      // Force userId from the authenticated actor — a client cannot create a
      // connector owned by someone else. Strip any client-supplied userId.
      const raw = (parsed.value ?? {}) as Record<string, unknown>;
      // User-authoring surface: reject admin-only fields server-side (not merely
      // ignore them) THEN force the connector private + non-default — a tampered
      // client body can never smuggle a shared / default-on connector through.
      if (mode === 'user') {
        const rejected = rejectAdminOnlyFields(raw);
        if (rejected !== null) {
          res.status(400).json({ error: rejected });
          return;
        }
        // POST is create-OR-update (upsert by id). If the id already names a
        // catalog/shared connector the actor owns, this would silently DEMOTE it
        // to private — the same read-only bypass PATCH/DELETE guard against. So
        // pre-read and 403 before the forced-private upsert can land.
        const cid = raw.connectorId;
        if (typeof cid === 'string' && cid.length > 0) {
          try {
            const got = await deps.bus.call<GetInput, GetOutput>(
              'connectors:get',
              ctx,
              { userId: actor.id, connectorId: cid },
            );
            if (isCatalogConnector(got.connector)) {
              res.status(403).json({ error: 'read-only' });
              return;
            }
          } catch (err) {
            // not-found ⟹ a genuine create — fall through. Any other hook error
            // (e.g. invalid id) surfaces here with the right status.
            if (!(err instanceof PluginError && err.code === 'not-found')) {
              handleHookError(err, res);
              return;
            }
          }
        }
        raw.visibility = 'private';
        raw.defaultAttached = false;
      }
      const input = { ...raw, userId: actor.id } as unknown as UpsertInput;
      try {
        const out = await deps.bus.call<UpsertInput, UpsertOutput>(
          'connectors:upsert',
          ctx,
          input,
        );
        res
          .status(out.created ? 201 : 200)
          .json({ connector: out.connector, created: out.created });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /** PATCH /admin/connectors/:id — owner only. */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      const parsed = parseAndValidateBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      // The connector must already exist AND be owned by the actor — a PATCH of a
      // foreign / missing connector 404s (connectors:get scopes by userId). This
      // also means PATCH cannot CREATE: the id in the URL is authoritative.
      let existing: Connector;
      try {
        const got = await deps.bus.call<GetInput, GetOutput>(
          'connectors:get',
          ctx,
          { userId: actor.id, connectorId: id },
        );
        existing = got.connector;
      } catch (err) {
        handleHookError(err, res);
        return;
      }
      // User-authoring surface: a catalog/shared connector (admin-curated) is
      // READ-ONLY for a non-admin author — editing it 403s, even when the actor
      // happens to own the row. This is the server-side enforcement of
      // "catalog/shared connectors are read-only for non-admins."
      if (mode === 'user' && isCatalogConnector(existing)) {
        res.status(403).json({ error: 'read-only' });
        return;
      }
      // Merge the patch over the existing connector, then re-assert id + userId
      // from the URL / session so a malicious body can't rename or owner-hijack.
      const patchRaw = (parsed.value ?? {}) as Record<string, unknown>;
      delete patchRaw.userId;
      delete patchRaw.connectorId;
      delete patchRaw.id;
      // User-authoring surface: reject admin-only fields server-side, then force
      // the connector private + non-default after the spread below — a user PATCH
      // can never flip an owned private connector to shared / default-on.
      if (mode === 'user') {
        const rejected = rejectAdminOnlyFields(patchRaw);
        if (rejected !== null) {
          res.status(400).json({ error: rejected });
          return;
        }
        patchRaw.visibility = 'private';
        patchRaw.defaultAttached = false;
      }
      const input: UpsertInput = {
        name: existing.name,
        description: existing.description,
        usageNote: existing.usageNote,
        keyMode: existing.keyMode,
        visibility: existing.visibility,
        capabilities: existing.capabilities,
        defaultAttached: existing.defaultAttached,
        ...patchRaw,
        // Re-assert the immutable identity + owner AFTER the spread so a stray
        // patch field can't rename or owner-hijack.
        userId: actor.id,
        connectorId: existing.id,
      } as UpsertInput;
      try {
        const out = await deps.bus.call<UpsertInput, UpsertOutput>(
          'connectors:upsert',
          ctx,
          input,
        );
        res.status(200).json({ connector: out.connector, created: out.created });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /** DELETE /admin/connectors/:id — owner only. */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      // User-authoring surface: a catalog/shared connector is read-only for a
      // non-admin author — deleting it 403s. Read it first so we can tell a
      // catalog/shared connector (403) from a missing/foreign one (404).
      if (mode === 'user') {
        let existing: Connector;
        try {
          const got = await deps.bus.call<GetInput, GetOutput>('connectors:get', ctx, {
            userId: actor.id,
            connectorId: id,
          });
          existing = got.connector;
        } catch (err) {
          handleHookError(err, res);
          return;
        }
        if (isCatalogConnector(existing)) {
          res.status(403).json({ error: 'read-only' });
          return;
        }
      }
      try {
        const out = await deps.bus.call<DeleteInput, DeleteOutput>(
          'connectors:delete',
          ctx,
          { userId: actor.id, connectorId: id },
        );
        if (!out.deleted) {
          // Soft-delete returns false when there was nothing (owned) to delete —
          // surface as 404 (same leak posture as a foreign-owned read).
          res.status(404).json({ error: 'not-found' });
          return;
        }
        res.status(204).end();
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /**
     * POST /admin/connectors/:id/test — probe an owned connector for setup
     * completeness (TASK-108). 200 `{ status, detail? }` where status is
     * `reachable` | `unreachable` | `needs-key`. A foreign / missing connector
     * 404s (same leak posture as the owner-scoped read). No request body.
     */
    async test(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      let connector: Connector;
      try {
        const got = await deps.bus.call<GetInput, GetOutput>('connectors:get', ctx, {
          userId: actor.id,
          connectorId: id,
        });
        connector = got.connector;
      } catch (err) {
        handleHookError(err, res);
        return;
      }
      const result = await probeConnector(connector, {
        bus: deps.bus,
        ctx,
        actorId: actor.id,
      });
      res.status(200).json(result);
    },
  };
}

/**
 * Back-compat alias — the admin Connector registry route bundle. Equivalent to
 * `createConnectorRouteHandlers({ bus, mode: 'admin' })`. Kept so the existing
 * registration + tests keep their name.
 */
export function createAdminConnectorRouteHandlers(deps: AdminRouteDeps) {
  return createConnectorRouteHandlers({ ...deps, mode: 'admin' });
}

// --- registration ---------------------------------------------------------

/**
 * Register all six admin routes against @ax/http-server. Returned unregister
 * callbacks should be tracked by the plugin and called on shutdown so a re-init
 * (tests) doesn't trip duplicate-route.
 */
export async function registerAdminConnectorRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createConnectorRouteHandlers({ bus, mode: 'admin' });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/connectors', handler: handlers.list },
    { method: 'POST', path: '/admin/connectors', handler: handlers.create },
    { method: 'GET', path: '/admin/connectors/:id', handler: handlers.show },
    { method: 'PATCH', path: '/admin/connectors/:id', handler: handlers.update },
    { method: 'DELETE', path: '/admin/connectors/:id', handler: handlers.destroy },
    { method: 'POST', path: '/admin/connectors/:id/test', handler: handlers.test },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}

/**
 * Register the user-authoring routes against @ax/http-server (TASK-129). These
 * are the locked-down `/settings/connectors[/:id]` surface: same owner-scoped,
 * owner-forced-from-session bridge as the admin routes, but in `mode: 'user'`
 * so the connector is forced PRIVATE, admin-only fields are rejected, and a
 * catalog/shared connector is read-only (see `ConnectorRouteMode`).
 *
 * NOTE: there is deliberately no `/settings/connectors/:id/test` — the Test
 * probe is an admin curation action, not part of user authoring.
 *
 * Returned unregister callbacks should be tracked by the plugin and called on
 * shutdown so a re-init (tests) doesn't trip duplicate-route.
 */
export async function registerUserConnectorRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createConnectorRouteHandlers({ bus, mode: 'user' });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/settings/connectors', handler: handlers.list },
    { method: 'POST', path: '/settings/connectors', handler: handlers.create },
    { method: 'GET', path: '/settings/connectors/:id', handler: handlers.show },
    { method: 'PATCH', path: '/settings/connectors/:id', handler: handlers.update },
    {
      method: 'DELETE',
      path: '/settings/connectors/:id',
      handler: handlers.destroy,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}
