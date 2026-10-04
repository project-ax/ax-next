import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import {
  deleteConfig,
  loadConfigById,
  loadConfigs,
  parseConfig,
  saveConfig,
  type McpServerConfig,
} from './config.js';
import { McpConnection } from './connection.js';
import { purgeMcpCredentials } from './credential-purge.js';
import {
  createTransport,
  type BusLike,
  type CreateTransportOptions,
  type McpClientTransport,
} from './transports.js';

/** Extract declared header credential ref keys from a config (http/sse only). */
function headerNamesOf(cfg: McpServerConfig): string[] {
  if (
    (cfg.transport === 'streamable-http' || cfg.transport === 'sse') &&
    cfg.headerCredentialRefs !== undefined
  ) {
    return Object.keys(cfg.headerCredentialRefs);
  }
  return [];
}

// ---------------------------------------------------------------------------
// HTTP route handlers for /admin/mcp-servers[/:id][/test]. Mirrors the
// agents/admin-routes.ts pattern (Task 9): handlers duck-type the
// http-server's req/res surface so the plugin stays I2-clean (no @ax/*
// cross-imports beyond @ax/core).
//
// All endpoints require auth:require-user (401 on miss).
//
// Writes — POST, PATCH, DELETE — and the outbound POST /:id/test probe
// require a WORKSPACE ADMIN (403 `forbidden` otherwise, before the row is
// even looked up, so a non-admin learns nothing about which ids exist).
// TASK-848: a host MCP server's tools land in the one global tool catalog,
// and a wildcard-scoped agent (every product agent today) sees that whole
// catalog — so a server registered by any signed-in user reached every
// user's agents, and pointed the host at a URL of that user's choosing.
// Ownership is not authority here; admin is. Admins manage every row,
// including admin-global (`ownerId === null`) rows and rows a non-admin
// created before the gate existed.
//
// Read-scoping rule: an admin sees every row; anyone else sees a config iff
// `ownerId === U.id` OR `ownerId === null` (admin-global).
//
// Responses NEVER include resolved credential values. The schema's
// `credentialRefs` (and `headerCredentialRefs`) carry credential IDs;
// the values resolve at connection time via `credentials:get` and never
// touch a response body. Test pinned in admin-routes.test.ts.
//
// The /test endpoint opens a real outbound MCP connection bounded by
// MCP_TEST_TIMEOUT_MS. Connection failures surface as 200 `{ok:false,
// error}` with sanitized error codes (no stack traces, no remote response
// bubbles). Timeouts are 504.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/mcp-client';

/** 64 KiB cap on request bodies. Mirrors @ax/agents — wide enough for a
 *  full MCP config with credentialRefs but smaller than the http-server's
 *  1 MiB cap so the admin API doesn't accept blobs the storage layer
 *  can't sanely hold. */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

/** Bound on /test — connect + listTools must complete inside this window
 *  or we 504. Matches the spec's 30s. */
export const MCP_TEST_TIMEOUT_MS = 30_000;

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import) -------------------------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/admin/mcp-servers/:id` (and `:id/test`). */
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

interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

async function requireUser(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
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

/**
 * /admin/mcp-servers write gate (TASK-848). 401 → unauthenticated; 403 →
 * authenticated but not a workspace admin. Mirrors the per-plugin
 * `requireAdmin` the other /admin route plugins carry (branding, blob-gc,
 * credentials-admin-routes, …) — duplicated rather than imported, per the
 * no-cross-plugin-imports invariant. Fails closed: anything but an explicit
 * `isAdmin === true` is refused.
 */
async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  const actor = await requireUser(bus, ctx, req, res);
  if (actor === null) return null;
  if (actor.isAdmin !== true) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
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

function parseAndValidateBody(
  body: Buffer,
): ParsedBody<unknown> | ParseError {
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
 * Visibility predicate for reads. Admins see every row (they manage them
 * all — see the header). For everyone else, admin-global rows
 * (`ownerId === null`) are visible and owned rows only to their owner.
 * Foreign-owned rows are NOT visible — we return 404 (not 403) because
 * "this row exists but isn't yours" leaks more than "no such row".
 */
function canRead(cfg: McpServerConfig, actor: AuthedUser): boolean {
  return actor.isAdmin === true || cfg.ownerId === null || cfg.ownerId === actor.id;
}

/**
 * Strip credential VALUES from a config before serializing. We always
 * preserve the keys/IDs in `credentialRefs` and `headerCredentialRefs` —
 * those are the indirection identifiers and are not secrets — but we
 * never resolve them (`credentials:get` is reached only at connect time
 * inside `McpConnection`, never from a response handler).
 *
 * Today the McpServerConfig type has NO field that contains a resolved
 * credential value (only the *Refs maps). This function exists as a
 * defensive pass: if a future field is added that holds a resolved value,
 * it should be stripped here AND a regression test added. The current
 * impl is therefore an identity function with the explicit doc comment
 * that documents the invariant — `JSON.parse(JSON.stringify(cfg))` works
 * because all McpServerConfig variants are JSON-clean.
 */
function serializeConfig(cfg: McpServerConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
}

/**
 * Connect to the MCP server, list its tools, and tear the connection down
 * — bounded by `MCP_TEST_TIMEOUT_MS`. Returns one of three discriminated
 * outcomes: `ok` (successful list), `failed` (connect / list-tools error),
 * `timed-out` (the wall-clock window expired).
 *
 * Never echoes the raw error message: `String(err.code ?? err.name ??
 * 'connection-failed')` is the most we surface. Stack traces and any
 * remote response strings stay inside the connection layer.
 */
export type TestOutcome =
  | { kind: 'ok'; toolCount: number; toolNames: string[] }
  | { kind: 'failed'; error: string }
  | { kind: 'timed-out' };

export interface TestDeps {
  bus: BusLike;
  ctx: AgentContext;
  /** Test seam — production callers leave this undefined. */
  transportFactory?: (opts: CreateTransportOptions) => Promise<McpClientTransport>;
  /** Test seam — production callers leave this at default. */
  timeoutMs?: number;
}

export async function testMcpConnection(
  config: McpServerConfig,
  deps: TestDeps,
): Promise<TestOutcome> {
  const timeoutMs = deps.timeoutMs ?? MCP_TEST_TIMEOUT_MS;
  const connection = new McpConnection({
    config,
    bus: deps.bus,
    ctx: deps.ctx,
    ...(deps.transportFactory !== undefined
      ? { transportFactory: deps.transportFactory }
      : {}),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work: Promise<TestOutcome> = (async () => {
      try {
        await connection.connect();
      } catch (err) {
        return { kind: 'failed', error: extractErrorCode(err) } as TestOutcome;
      }
      const listed = await connection.listTools();
      if (!listed.ok) {
        return { kind: 'failed', error: listed.code } as TestOutcome;
      }
      return {
        kind: 'ok',
        toolCount: listed.tools.length,
        toolNames: listed.tools.map((t) => t.name),
      } as TestOutcome;
    })();
    const timeoutPromise = new Promise<TestOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timed-out' }), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Best-effort teardown — the connection may already be in 'closed'
    // / 'unhealthy', and disconnect() is idempotent. Don't bubble errors
    // from here; the test endpoint's job is to report, not to fail.
    try {
      await connection.disconnect();
    } catch {
      // ignored
    }
  }
}

function extractErrorCode(err: unknown): string {
  if (err instanceof PluginError) {
    return String(err.code);
  }
  if (err !== null && typeof err === 'object') {
    const obj = err as { code?: unknown; name?: unknown };
    if (typeof obj.code === 'string' && obj.code.length > 0) return obj.code;
    if (typeof obj.name === 'string' && obj.name.length > 0) return obj.name;
  }
  return 'connection-failed';
}

// --- handler factory ------------------------------------------------------

export interface AdminRouteDeps {
  bus: HookBus;
  /** Test seam: override the transport used by /test. */
  testTransportFactory?: (opts: CreateTransportOptions) => Promise<McpClientTransport>;
  /** Test seam: shorten the /test timeout. */
  testTimeoutMs?: number;
}

export function createAdminMcpRouteHandlers(deps: AdminRouteDeps) {
  // Per-handler-bundle ctx mirrors the @ax/agents admin-routes pattern.
  // Every storage:get / storage:set call attributes to this synthetic
  // ctx; the real actor id flows through closure-scoped local variables.
  const ctx = makeAgentContext({
    sessionId: 'mcp-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  // BusLike adapter — McpConnection wants a narrowed shape (no .fire,
  // .subscribe). The HookBus's .call signature is structurally compatible,
  // so we reuse it directly via a structural cast (no runtime wrap).
  const busAsBusLike: BusLike = {
    call: deps.bus.call.bind(deps.bus) as BusLike['call'],
  };

  return {
    /** POST /admin/mcp-servers — workspace admin only (TASK-848) */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const parsed = parseAndValidateBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      // Force ownerId to the calling user — clients cannot create configs
      // owned by someone else. Strip any client-supplied ownerId before
      // validation so an attempted impersonation surfaces clearly.
      const raw = (parsed.value ?? {}) as Record<string, unknown>;
      const candidate: Record<string, unknown> = { ...raw, ownerId: actor.id };
      let cfg: McpServerConfig;
      try {
        cfg = parseConfig(candidate);
      } catch (err) {
        if (err instanceof PluginError) {
          res.status(400).json({ error: err.message });
          return;
        }
        // ZodError from McpServerConfigSchema.parse — surface a single
        // collapsed message; never echo internal field paths.
        const message =
          err instanceof Error && err.message.length > 0
            ? simplifyZodMessage(err.message)
            : 'invalid-payload';
        res.status(400).json({ error: message });
        return;
      }
      // Refuse overwrites — if a row with this id already exists, we
      // demand the caller use PATCH (so we don't silently change owners
      // on a collision). loadConfigById returns null for tombstones too,
      // which is fine — id is reusable after delete.
      const existing = await loadConfigById(deps.bus, ctx, cfg.id);
      if (existing !== null) {
        res.status(409).json({ error: 'already-exists' });
        return;
      }
      try {
        const saved = await saveConfig(deps.bus, ctx, cfg);
        res.status(201).json({ config: serializeConfig(saved) });
      } catch (err) {
        if (err instanceof PluginError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    },

    /** GET /admin/mcp-servers */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const all = await loadConfigs(deps.bus, ctx);
      // Read-scope: admins see every row; anyone else only their own
      // configs + admin-global. Filter BEFORE serializing so a foreign-owned config never reaches the
      // wire. (Invariant I7 / Acceptance scenario 6.)
      const visible = all.filter((c) => canRead(c, actor));
      res.status(200).json({
        configs: visible.map(serializeConfig),
      });
    },

    /** GET /admin/mcp-servers/:id */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      let cfg: McpServerConfig | null;
      try {
        cfg = await loadConfigById(deps.bus, ctx, id);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      if (cfg === null || !canRead(cfg, actor)) {
        // 404 not 403 — "doesn't exist" is the safer leak (matches the
        // cross-tenant rule in Task 10 spec).
        res.status(404).json({ error: 'not-found' });
        return;
      }
      res.status(200).json({ config: serializeConfig(cfg) });
    },

    /** PATCH /admin/mcp-servers/:id — workspace admin only (TASK-848) */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      if ((await requireAdmin(deps.bus, ctx, req, res)) === null) return;
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
      let existing: McpServerConfig | null;
      try {
        existing = await loadConfigById(deps.bus, ctx, id);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      if (existing === null) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      // Merge: caller may patch any field except `id` and `ownerId`. We
      // always reassert `id` from the URL and `ownerId` from the existing
      // row so a malicious payload can't sneak an id-rename or owner-
      // hijack through.
      const patchRaw = (parsed.value ?? {}) as Record<string, unknown>;
      // Remove forbidden fields before merge so we never echo them as
      // "rejected" — the merge naturally ignores them.
      delete patchRaw.id;
      delete patchRaw.ownerId;
      const merged: Record<string, unknown> = {
        ...existing,
        ...patchRaw,
        id: existing.id,
        ownerId: existing.ownerId,
      };
      let cfg: McpServerConfig;
      try {
        cfg = parseConfig(merged);
      } catch (err) {
        if (err instanceof PluginError) {
          res.status(400).json({ error: err.message });
          return;
        }
        const message =
          err instanceof Error && err.message.length > 0
            ? simplifyZodMessage(err.message)
            : 'invalid-payload';
        res.status(400).json({ error: message });
        return;
      }
      let saved: McpServerConfig;
      try {
        saved = await saveConfig(deps.bus, ctx, cfg);
      } catch (err) {
        // e.g. a row whose id predates the reserved form (TASK-752).
        if (err instanceof PluginError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      // Purge credentials for header names that were in the old config but
      // are absent from the new one. Graceful: a credential hiccup must NOT
      // fail the config update — log and continue.
      const oldHeaderNames = headerNamesOf(existing);
      const newHeaderNames = new Set(headerNamesOf(saved));
      const droppedHeaderNames = oldHeaderNames.filter((n) => !newHeaderNames.has(n));

      if (droppedHeaderNames.length > 0) {
        try {
          await purgeMcpCredentials(deps.bus, ctx, saved.id, [], droppedHeaderNames);
        } catch (err) {
          ctx.logger.warn('mcp_credential_purge_failed_on_update', {
            serverId: saved.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.status(200).json({ config: serializeConfig(saved) });
    },

    /** DELETE /admin/mcp-servers/:id — workspace admin only (TASK-848) */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      if ((await requireAdmin(deps.bus, ctx, req, res)) === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      let existing: McpServerConfig | null;
      try {
        existing = await loadConfigById(deps.bus, ctx, id);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      if (existing === null) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      // Capture the declared header names before the row is tombstoned.
      const allHeaderNames = headerNamesOf(existing);

      await deleteConfig(deps.bus, ctx, id);

      // Purge all credential refs for this server's declared header slots.
      // Graceful: a credential hiccup must NOT fail the delete — log + continue.
      if (allHeaderNames.length > 0) {
        try {
          await purgeMcpCredentials(deps.bus, ctx, id, [], allHeaderNames);
        } catch (err) {
          ctx.logger.warn('mcp_credential_purge_failed_on_delete', {
            serverId: id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.status(204).end();
    },

    /** POST /admin/mcp-servers/:id/test — workspace admin only (TASK-848):
     *  it opens an outbound connection from the host to the row's URL. */
    async test(req: RouteRequest, res: RouteResponse): Promise<void> {
      if ((await requireAdmin(deps.bus, ctx, req, res)) === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      let existing: McpServerConfig | null;
      try {
        existing = await loadConfigById(deps.bus, ctx, id);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      if (existing === null) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      const testDeps: TestDeps = {
        bus: busAsBusLike,
        ctx,
        ...(deps.testTransportFactory !== undefined
          ? { transportFactory: deps.testTransportFactory }
          : {}),
        ...(deps.testTimeoutMs !== undefined ? { timeoutMs: deps.testTimeoutMs } : {}),
      };
      const outcome = await testMcpConnection(existing, testDeps);
      if (outcome.kind === 'timed-out') {
        res.status(504).json({ error: 'timeout' });
        return;
      }
      if (outcome.kind === 'failed') {
        res.status(200).json({ ok: false, error: outcome.error });
        return;
      }
      res.status(200).json({
        ok: true,
        toolCount: outcome.toolCount,
        toolNames: outcome.toolNames,
      });
    },
  };
}

/**
 * Collapse Zod's multi-line "Expected X received Y at path.foo.bar" into
 * a short message. We never leak field paths (some are internal-shape
 * names like `_def` paths from refinements). Best-effort: keep the first
 * line, strip trailing path detail.
 */
function simplifyZodMessage(raw: string): string {
  const firstLine = raw.split('\n')[0] ?? raw;
  // Strip "at <path>" suffixes the Zod default reporter appends.
  return firstLine.replace(/\s+at\s+["'][^"']+["']\s*$/, '');
}

// --- registration ---------------------------------------------------------

/**
 * Register all six admin routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called on
 * shutdown so a re-init in tests doesn't trip duplicate-route.
 */
export async function registerAdminMcpRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  opts: {
    testTransportFactory?: (opts: CreateTransportOptions) => Promise<McpClientTransport>;
    testTimeoutMs?: number;
  } = {},
): Promise<Array<() => void>> {
  const handlers = createAdminMcpRouteHandlers({
    bus,
    ...(opts.testTransportFactory !== undefined
      ? { testTransportFactory: opts.testTransportFactory }
      : {}),
    ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}),
  });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'POST', path: '/admin/mcp-servers', handler: handlers.create },
    { method: 'GET', path: '/admin/mcp-servers', handler: handlers.list },
    { method: 'GET', path: '/admin/mcp-servers/:id', handler: handlers.show },
    { method: 'PATCH', path: '/admin/mcp-servers/:id', handler: handlers.update },
    { method: 'DELETE', path: '/admin/mcp-servers/:id', handler: handlers.destroy },
    { method: 'POST', path: '/admin/mcp-servers/:id/test', handler: handlers.test },
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

// `createTransport` is re-exported so tests in this package can still
// use the production transport-factory path without reaching into private
// modules.
export { createTransport };
