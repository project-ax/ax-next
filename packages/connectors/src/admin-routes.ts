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

// --- handler factory ------------------------------------------------------

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminConnectorRouteHandlers(deps: AdminRouteDeps) {
  // Per-handler-bundle ctx mirrors the @ax/mcp-client / @ax/agents pattern. The
  // synthetic ctx attributes the bus calls; the real actor id flows through the
  // hook input (`userId`), forced from the authenticated session below.
  const ctx = makeAgentContext({
    sessionId: 'connectors-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
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
      // Merge the patch over the existing connector, then re-assert id + userId
      // from the URL / session so a malicious body can't rename or owner-hijack.
      const patchRaw = (parsed.value ?? {}) as Record<string, unknown>;
      delete patchRaw.userId;
      delete patchRaw.connectorId;
      delete patchRaw.id;
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
  };
}

// --- registration ---------------------------------------------------------

/**
 * Register all five admin routes against @ax/http-server. Returned unregister
 * callbacks should be tracked by the plugin and called on shutdown so a re-init
 * (tests) doesn't trip duplicate-route.
 */
export async function registerAdminConnectorRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminConnectorRouteHandlers({ bus });
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
