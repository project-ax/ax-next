import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { TOOL_PERMISSIONS_RESET_FAILED } from '@ax/core/error-codes';
import type {
  ClearAuthoredInput,
  ClearAuthoredOutput,
  Connector,
  ConnectorSummary,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetOutput,
  ListInput,
  ListOutput,
  ListAuthoredPendingInput,
  ListAuthoredPendingOutput,
  UpsertInput,
  UpsertOutput,
} from './types.js';
import { CapabilitiesSchema, withCapabilityDefaults } from './types.js';
import { deriveCredentialPlan } from './credential-plan.js';
import { deriveToolNamespaces } from './tool-namespace.js';
import {
  parseToolPermissionsBody,
  shapeInventory,
  type DescribeToolsInputLike,
  type DescribeToolsOutputLike,
  type GetConnectorDefaultsInputLike,
  type GetConnectorDefaultsOutputLike,
  type InventoryToolLike,
  type SetConnectorDefaultsInputLike,
  type SetConnectorDefaultsOutputLike,
} from './tool-permissions.js';

// Structural mirrors of the orchestrator's authored-connector grant hook
// (registered by @ax/chat-orchestrator) + the agents ACL gate. Re-declared here
// per Invariant I2 (no cross-plugin import); the orchestrator validates
// authoritatively, so this is just the call shape. The grant re-resolves the
// agent's OWN authored drafts host-side (server-authoritative), so an unknown /
// foreign connectorId returns `not-authored` — it can never approve a draft the
// caller doesn't own.
interface ApplyAuthoredConnectorGrantInputLike {
  /** Omitted on this path: a Settings approval has no live conversation
   *  (the "approve-ahead" branch — writes approval rows + promotes to the
   *  registry + flips the draft active, with no warm-session retire). */
  conversationId?: string;
  userId: string;
  agentId: string;
  connectorId: string;
  shown?: { hosts: string[]; slots: string[]; npm: string[]; pypi: string[] };
}
type ApplyAuthoredConnectorGrantOutputLike =
  | { applied: true; respawned: boolean }
  | { applied: false; reason: 'not-authored' };

interface AgentsResolveInputLike {
  agentId: string;
  userId: string;
}

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
// All endpoints require auth:require-user (401 on miss). The `/admin/connectors*`
// bundle (mode 'admin') is ADMIN-ONLY: a signed-in non-admin gets 403 on every one
// of its routes, exactly like the other `/admin/*` surfaces (TASK-698) — it is the
// curation surface (shared / workspace-keyed connectors, the Test
// probe), and before the gate it was a bypass of the `/settings/connectors`
// rejections. The `/settings/connectors*` bundle (mode 'user') is READS only
// (list/show/tool-permissions GET + the authored-draft routes; any signed-in
// user): its write handlers 403 a non-admin and no write route is registered
// there, so those paths 404. Connectors are
// readable when owned by the actor or explicitly shared. Writes are owner-only,
// with one exception: on the admin bundle any admin may edit or delete a SHARED
// definition someone else owns, and the write lands on the OWNER's row (owner
// taken from the stored row, never the request; ownership never changes).
// Actor identity is forced from the session and canEdit is derived by the store.
// Private foreign definitions stay invisible. On the user surface shared foreign
// definitions are read-only.
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
 * hooks throw structured codes (`invalid-payload`, `not-found`,
 * `tool-permissions-reset-failed`); everything
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
    if (err.code === 'connector-id-taken') {
      res.status(409).json({ error: 'connector-id-taken' });
      return;
    }
    // TASK-758 — an endpoint change whose tool-permission reset failed was
    // refused before anything was written. Retryable, so a 503, and a fixed
    // string the editors key their message on (never the cause's text).
    if (err.code === TOOL_PERMISSIONS_RESET_FAILED) {
      res.status(503).json({ error: TOOL_PERMISSIONS_RESET_FAILED });
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
//                 leading server declares no `url`, so it can't connect to
//                 anything.
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

  // Config sanity: an MCP-backed connector's leading server must have a url.
  // A connector with no mcpServers is CLI/package/direct-API backed and passes
  // (its reach is the allowedHosts + the now-verified slots).
  const leadServer = connector.capabilities.mcpServers[0];
  if (leadServer !== undefined) {
    if (typeof leadServer.url !== 'string' || leadServer.url.trim().length === 0) {
      return { status: 'unreachable', detail: 'MCP server has no url' };
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
 * Connector registry and the read-only `/settings` surface (TASK-129).
 *
 *   - `'admin'` — the folded Connector registry (`/admin/connectors`). The actor
 *     may curate the workspace catalog: set `visibility: 'shared'` and
 *     `keyMode: 'workspace'`. Owner is still forced from the session.
 *   - `'user'`  — the `/settings/connectors` READ surface (list/show/tool-
 *     permissions reads + the authored-draft routes). Only admins write
 *     connector definitions (slice 2a), so no write route is registered in this
 *     mode and the write handlers 403 a non-admin even if one were wired.
 *
 * Both modes share the read paths (list/show) and the owner-forced-from-session
 * posture verbatim; the `'admin'` bundle requires an admin (403 otherwise —
 * TASK-698), while the user reads have no role gate (any authenticated user may
 * read, e.g. the agent rail's Add list).
 */
export type ConnectorRouteMode = 'admin' | 'user';

/** Shared reads grant no writes; workspace credentials remain admin-curated. */
function isReadOnly(c: Connector): boolean {
  return c.canEdit === false;
}

/**
 * Slice 2a — any admin may curate any SHARED connector, whoever defined it. True
 * only on the admin bundle (whose `authenticate` already 403s a non-admin) and
 * only for a shared definition: a private one someone else owns never reaches
 * here (`connectors:get` 404s it), and the user surface never gets this reach.
 */
function adminCurates(c: Connector, mode: ConnectorRouteMode): boolean {
  return mode === 'admin' && c.visibility === 'shared';
}

/**
 * Whose row a write acts on, or null when the actor may only read it. The
 * actor's own row when they may edit it; on the admin bundle, a shared row
 * another person owns is written AS that owner's row — the hooks are keyed by
 * owner, and ownership never changes on an edit. The owner always comes from
 * the stored row (`connectors:get`), never from the request.
 */
function writeOwner(
  got: GetOutput,
  actorId: string,
  mode: ConnectorRouteMode,
): string | null {
  if (!isReadOnly(got.connector) && got.connector.canEdit === true) return actorId;
  if (adminCurates(got.connector, mode)) return got.ownerUserId;
  return null;
}

/** Stable JSON: object keys sorted, so key order never reads as a change. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );
}

/**
 * Fix round 1 (security). A NON-owner admin may relabel a shared connector
 * (name / description / usage note; tool permissions on their own route) but
 * never change where it connects or who supplies the key. `capabilities`
 * (servers + endpoints, allowed hosts, credential slots incl. OAuth client
 * fields, packages, services), `keyMode` and `visibility` are the owner's: an
 * endpoint change would hand every agent's stored sign-ins and the shared key
 * to the new host through the credential proxy (only tool permissions are reset
 * on a move — TASK-758). A field sent with its STORED value is fine; editors
 * send the whole form. Capabilities are compared after the same parse the store
 * applies, so defaults (e.g. `services: []`) never read as a change; an
 * unparseable value is a change (refused). Both sides also get the OAuth slot
 * defaults (`withCapabilityDefaults`): a slot that spells out
 * `clientRegistration: 'custom'` / `scopes: []` means the same as one that
 * leaves them out, so an editor filling them in is not a retarget — while a
 * different value still is.
 */
/**
 * Fix round 3 (security) — the only body fields a NON-owner admin's PATCH
 * writes: the labels. Everything that decides reach (capabilities, keyMode,
 * visibility) is taken from the stored row on that path.
 */
const DISPLAY_FIELDS = ['name', 'description', 'usageNote'] as const;

function changesOwnerOnlyFields(existing: Connector, patch: Record<string, unknown>): boolean {
  if ('keyMode' in patch && patch.keyMode !== existing.keyMode) return true;
  if ('visibility' in patch && patch.visibility !== existing.visibility) return true;
  if ('capabilities' in patch) {
    const parsed = CapabilitiesSchema.safeParse(patch.capabilities);
    if (!parsed.success) return true;
    if (
      canonicalJson(withCapabilityDefaults(parsed.data)) !==
      canonicalJson(withCapabilityDefaults(existing.capabilities))
    )
      return true;
  }
  return false;
}

/** What the admin surface tells the UI it may edit (the store's `canEdit` is
 *  owner-only; an admin may also curate any shared connector). */
function presentCanEdit<T extends { canEdit?: boolean; visibility: Connector['visibility'] }>(
  c: T,
  mode: ConnectorRouteMode,
): T {
  return c.canEdit !== true && mode === 'admin' && c.visibility === 'shared'
    ? { ...c, canEdit: true }
    : c;
}

/**
 * A write body (POST and PATCH) must be a JSON object: a field map. A primitive
 * would otherwise reach `in` checks (which throw on a primitive → 500) and an
 * array or string would be spread into the row key by key. Returns the 400
 * message, else null.
 */
function rejectNonObjectBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  return null;
}

/**
 * TASK-808 — "Set default" is gone. For one release a write that still carries
 * the field (a stale client, a pinned tab, a script) fails LOUDLY instead of
 * being silently dropped, whatever the value: `false` is as stale as `true`
 * because the field no longer means anything. Both modes, POST and PATCH.
 * Returns the 400 message, else null.
 */
function rejectRemovedFields(body: unknown): string | null {
  // The body is untrusted JSON: only an object can carry the field (and `in`
  // throws on a primitive, which must stay a normal validation path).
  if (typeof body === 'object' && body !== null && 'defaultAttached' in body) {
    return 'defaultAttached is no longer supported: add connectors to each agent instead';
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

  /**
   * Authenticate the caller, then enforce the bundle's role policy. 401 when
   * signed out (checked first, so an anonymous caller learns nothing about roles),
   * then 403 `{ error: 'forbidden' }` when the bundle is admin-only and the actor
   * is not an admin — the same status/body every other `/admin/*` route answers.
   * Returns null once a response has been written (caller must early-return).
   *
   * `adminOnly` forces the role check regardless of mode: the Test probe and
   * every definition WRITE are curation actions, so they stay admin-only even
   * on a user-mode bundle (which registers reads only).
   */
  async function authenticate(
    req: RouteRequest,
    res: RouteResponse,
    opts: { adminOnly?: boolean } = {},
  ): Promise<{ id: string; isAdmin: boolean } | null> {
    const actor = await requireUser(deps.bus, ctx, req, res);
    if (actor === null) return null;
    if ((mode === 'admin' || opts.adminOnly === true) && !actor.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return actor;
  }

  /**
   * When an admin acts on a shared connector someone else defined, record WHO
   * did it (the hooks only see the row owner).
   */
  function logCuration(
    action: string,
    actorId: string,
    ownerUserId: string,
    connectorId: string,
  ): void {
    if (ownerUserId === actorId) return;
    ctx.logger.info('connectors_admin_curated_shared', {
      action,
      actorId,
      ownerUserId,
      connectorId,
    });
  }

  /**
   * Authenticate, then load a connector the actor may EDIT (TASK-737). 404 for
   * a missing / invisible one (same leak posture as `show`), 403 `read-only`
   * for one they can only read. On success also returns the row owner the
   * writes act on (see `writeOwner`) and the connector's tool namespaces —
   * derived from that OWNER, since namespaces are keyed by the row owner.
   */
  async function loadEditable(
    req: RouteRequest,
    res: RouteResponse,
    opts: { adminOnly?: boolean } = {},
  ): Promise<{
    actor: { id: string; isAdmin: boolean };
    connector: Connector;
    owner: string;
    namespaces: string[];
  } | null> {
    const actor = await authenticate(req, res, opts);
    if (actor === null) return null;
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'missing-id' });
      return null;
    }
    let got: GetOutput;
    try {
      got = await deps.bus.call<GetInput, GetOutput>('connectors:get', ctx, {
        userId: actor.id,
        connectorId: id,
      });
    } catch (err) {
      handleHookError(err, res);
      return null;
    }
    const owner = writeOwner(got, actor.id, mode);
    if (owner === null) {
      res.status(403).json({ error: 'read-only' });
      return null;
    }
    const { connector } = got;
    const namespaces = deriveToolNamespaces(owner, connector).map((e) => e.toolNamespace);
    return { actor, connector, owner, namespaces };
  }

  return {
    /** GET /admin/connectors */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res);
      if (actor === null) return;
      const out = await deps.bus.call<ListInput, ListOutput>(
        'connectors:list',
        ctx,
        { userId: actor.id },
      );
      res.status(200).json({
        connectors: out.connectors.map((c) => presentCanEdit(c, mode)) satisfies ConnectorSummary[],
      });
    },

    /** GET /admin/connectors/:id */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res);
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
        // `connector` only — the owner id stays host-side.
        res.status(200).json({ connector: presentCanEdit(out.connector, mode) satisfies Connector });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /** POST /admin/connectors — create (or update an owned connector). */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res, { adminOnly: true });
      if (actor === null) return;
      const parsed = parseAndValidateBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      // Force userId from the authenticated actor — a client cannot create a
      // connector owned by someone else. Strip any client-supplied userId.
      const removed = rejectNonObjectBody(parsed.value) ?? rejectRemovedFields(parsed.value);
      if (removed !== null) {
        res.status(400).json({ error: removed });
        return;
      }
      const raw = parsed.value as Record<string, unknown>;
      // The route decides uniqueness, never the body (it would be an existence
      // probe for other owners' private ids).
      delete raw.requireUniqueId;
      // Likewise `updateOnly`: only the PATCH route sets it, never the body.
      delete raw.updateOnly;
      // POST is an upsert. Preserve saved settings on updates; apply defaults
      // only to genuinely new definitions. A shared read never grants a write.
      let existing: Connector | undefined;
      if (typeof raw.connectorId === 'string' && raw.connectorId.length > 0) {
        try {
          const got = await deps.bus.call<GetInput, GetOutput>(
            'connectors:get', ctx, { userId: actor.id, connectorId: raw.connectorId },
          );
          existing = got.connector;
          // POST creates (or updates the actor's OWN row). On the admin surface
          // another person's shared id is taken — editing it is a PATCH.
          if (existing.canEdit !== true && adminCurates(existing, mode)) {
            res.status(409).json({ error: 'connector-id-taken' });
            return;
          }
          if (isReadOnly(existing)) {
            res.status(403).json({ error: 'read-only' });
            return;
          }
        } catch (err) {
          if (!(err instanceof PluginError && err.code === 'not-found')) {
            handleHookError(err, res);
            return;
          }
        }
      }
      raw.visibility ??= existing?.visibility ?? 'shared';
      // Every create is an admin create (the handler is adminOnly), so an id
      // another owner holds is always taken.
      const input = {
        ...raw,
        userId: actor.id,
        requireUniqueId: true,
      } as unknown as UpsertInput;
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

    /** PATCH /admin/connectors/:id — the owner, or (admin bundle) any admin for a shared connector. */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res, { adminOnly: true });
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
      // Checked before any read, on the owner and the cross-owner path alike.
      const removed = rejectNonObjectBody(parsed.value) ?? rejectRemovedFields(parsed.value);
      if (removed !== null) {
        res.status(400).json({ error: removed });
        return;
      }
      // PATCH requires a live definition the actor may write. Missing/private
      // foreign ids return 404; a shared foreign definition is read-only except
      // to an admin on the admin bundle, who writes the OWNER's row.
      let got: GetOutput;
      try {
        got = await deps.bus.call<GetInput, GetOutput>(
          'connectors:get',
          ctx,
          { userId: actor.id, connectorId: id },
        );
      } catch (err) {
        handleHookError(err, res);
        return;
      }
      const existing = got.connector;
      const owner = writeOwner(got, actor.id, mode);
      if (owner === null) {
        res.status(403).json({ error: 'read-only' });
        return;
      }
      // Merge the patch over the existing connector, then re-assert id + userId
      // from the URL / session so a malicious body can't rename or owner-hijack.
      const patchRaw = parsed.value as Record<string, unknown>;
      delete patchRaw.userId;
      delete patchRaw.connectorId;
      delete patchRaw.id;
      const crossOwner = owner !== actor.id;
      // `changesOwnerOnlyFields` only picks the ANSWER (a humane 403 for a body
      // that really tries to retarget). It is not what keeps reach safe: a
      // cross-owner save below writes the STORED capabilities / keyMode /
      // visibility whatever the body says, so a disagreement between the
      // comparison's reading of a field and the runtime's can at worst give a
      // wrong 200/403 — never a changed reach.
      if (crossOwner && changesOwnerOnlyFields(existing, patchRaw)) {
        res.status(403).json({ error: 'owner-only-change' });
        return;
      }
      const editable: Record<string, unknown> = crossOwner
        ? Object.fromEntries(
            DISPLAY_FIELDS.filter((k) => k in patchRaw).map((k) => [k, patchRaw[k]]),
          )
        : patchRaw;
      const input: UpsertInput = {
        name: existing.name,
        description: existing.description,
        usageNote: existing.usageNote,
        keyMode: existing.keyMode,
        visibility: existing.visibility,
        capabilities: existing.capabilities,
        ...editable,
        requireUniqueId: false,
        // An edit never creates or resurrects: a delete that lands between the
        // read above and this write wins (→ 404), so slice 1's purge stands.
        updateOnly: true,
        // Re-assert the immutable identity + owner AFTER the spread so a stray
        // patch field can't rename or owner-hijack. The owner is the stored
        // row's, so ownership never changes on an edit.
        userId: owner,
        connectorId: existing.id,
      } as UpsertInput;
      try {
        const out = await deps.bus.call<UpsertInput, UpsertOutput>(
          'connectors:upsert',
          ctx,
          input,
        );
        logCuration('update', actor.id, owner, existing.id);
        res.status(200).json({
          connector: presentCanEdit(out.connector, mode),
          created: out.created,
        });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /** DELETE /admin/connectors/:id — the owner, or (admin bundle) any admin for a shared connector. */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res, { adminOnly: true });
      if (actor === null) return;
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      let owner: string | null;
      try {
        const got = await deps.bus.call<GetInput, GetOutput>('connectors:get', ctx, {
          userId: actor.id, connectorId: id,
        });
        owner = writeOwner(got, actor.id, mode);
      } catch (err) {
        handleHookError(err, res);
        return;
      }
      if (owner === null) {
        res.status(403).json({ error: 'read-only' });
        return;
      }
      try {
        const out = await deps.bus.call<DeleteInput, DeleteOutput>(
          'connectors:delete',
          ctx,
          // The hook is keyed by the row OWNER (an admin deleting another
          // admin's shared connector deletes that owner's row). Only admins
          // reach here, and an admin may purge a GLOBAL (shared/company)
          // credential on delete — this is the authority the hook gates on.
          { userId: owner, connectorId: id, purgeGlobal: true },
        );
        if (!out.deleted) {
          // Soft-delete returns false when there was nothing (owned) to delete —
          // surface as 404 (same leak posture as a foreign-owned read).
          res.status(404).json({ error: 'not-found' });
          return;
        }
        logCuration('delete', actor.id, owner, id);
        res.status(204).end();
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /**
     * POST /admin/connectors/:id/test — probe an owned connector for setup
     * completeness (TASK-108). ADMIN-ONLY in every mode (TASK-698): the verdict
     * (`needs-key` / `reachable`) reveals whether a GLOBAL-scope key exists for the
     * connector's derived ref, which a non-admin must not be able to probe.
     * 200 `{ status, detail? }` where status is
     * `reachable` | `unreachable` | `needs-key`. A foreign / missing connector
     * 404s (same leak posture as the owner-scoped read). No request body.
     */
    async test(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res, { adminOnly: true });
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

    /**
     * GET …/connectors/:id/tool-permissions[?refresh=1] — the connector's tool
     * list plus the per-tool defaults saved for it (TASK-737). Only someone who
     * may EDIT the connector gets an answer (the same `isReadOnly` gate PATCH
     * uses): a default here becomes a ceiling on every agent that uses it.
     *
     * Inventory is best-effort — an unreachable server or a preset without
     * `connectors:describe-tools` answers `status` + `tools: []`, and the saved
     * defaults still come back so the editor can show and change them.
     */
    async toolPermissions(req: RouteRequest, res: RouteResponse): Promise<void> {
      const target = await loadEditable(req, res);
      if (target === null) return;
      if (!deps.bus.hasService('tool-policy:get-connector-defaults')) {
        res.status(503).json({ error: 'unavailable' });
        return;
      }
      const { actor, connector, namespaces } = target;
      const own = new Set(namespaces);
      let status: DescribeToolsOutputLike['status'] = 'unknown';
      let checkedAt: string | null = null;
      let tools: InventoryToolLike[] = [];
      if (namespaces.length > 0 && deps.bus.hasService('connectors:describe-tools')) {
        try {
          const out = await deps.bus.call<DescribeToolsInputLike, DescribeToolsOutputLike>(
            'connectors:describe-tools',
            ctx,
            {
              // The actor's id resolves the same row `loadEditable` did (own row
              // first, else the single shared one); the owner only keys the namespaces.
              userId: actor.id,
              connectorId: connector.id,
              ...(req.query.refresh === '1' && { force: true }),
            },
          );
          status = out.status;
          checkedAt = out.checkedAt;
          tools = shapeInventory(out.tools, own);
        } catch (err) {
          // The list of tools is a convenience for the editor, never a gate:
          // a failed lookup reads as "we can't list them right now".
          ctx.logger.warn('connectors_tool_permissions_inventory_failed', {
            connectorId: connector.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const saved =
        namespaces.length === 0
          ? { defaults: [] }
          : await deps.bus.call<GetConnectorDefaultsInputLike, GetConnectorDefaultsOutputLike>(
              'tool-policy:get-connector-defaults',
              ctx,
              { connectorId: connector.id, toolNamespaces: namespaces },
            );
      res.status(200).json({ status, checkedAt, tools, defaults: saved.defaults });
    },

    /**
     * PUT …/connectors/:id/tool-permissions — body
     * `{ verdicts: [{ toolKey, verdict: 'allow'|'hold'|'deny'|null }] }`.
     * Same editor-only gate as the read. Every key must be one of THIS
     * connector's tools (see `parseToolPermissionsBody` — the policy hook does
     * not check that, by design). All-or-nothing.
     */
    async setToolPermissions(req: RouteRequest, res: RouteResponse): Promise<void> {
      const target = await loadEditable(req, res, { adminOnly: true });
      if (target === null) return;
      if (!deps.bus.hasService('tool-policy:set-connector-defaults')) {
        res.status(503).json({ error: 'unavailable' });
        return;
      }
      const body = parseAndValidateBody(req.body);
      if (!body.ok) {
        res.status(body.status).json({ error: body.message });
        return;
      }
      const parsed = parseToolPermissionsBody(body.value, new Set(target.namespaces));
      if (!parsed.ok) {
        res.status(400).json({
          error: parsed.error,
          ...(parsed.toolKey !== undefined && { toolKey: parsed.toolKey.slice(0, 200) }),
        });
        return;
      }
      if (parsed.verdicts.length === 0) {
        res.status(200).json({ ok: true });
        return;
      }
      const out = await deps.bus.call<SetConnectorDefaultsInputLike, SetConnectorDefaultsOutputLike>(
        'tool-policy:set-connector-defaults',
        // Attribute the write to the real editor (`updated_by`), not the
        // bundle's synthetic ctx.
        makeAgentContext({
          sessionId: `connectors-${mode}`,
          agentId: PLUGIN_NAME,
          userId: target.actor.id,
        }),
        { connectorId: target.connector.id, verdicts: parsed.verdicts },
      );
      if (!out.ok) {
        res.status(400).json({
          error: out.reason,
          ...(out.toolKey !== undefined && { toolKey: out.toolKey }),
        });
        return;
      }
      logCuration('set-tool-permissions', target.actor.id, target.owner, target.connector.id);
      res.status(200).json({ ok: true });
    },

    /**
     * GET /settings/connectors/authored — the Settings "Proposed by your
     * assistant" fallback list. Returns the session user's PENDING authored
     * connector drafts across ALL their agents (each carrying its `agentId` so
     * the approve action knows which (user, agent) authored it). Owner-scoped at
     * the store layer — a foreign user's draft can never appear. No request body.
     * Mechanism-agnostic: the response carries only the declared capability
     * surface (hosts / slot names / packages), never a secret.
     */
    async listAuthoredPending(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res);
      if (actor === null) return;
      if (!deps.bus.hasService('connectors:list-authored-pending')) {
        // The preset doesn't expose authored drafts — surface an empty list
        // rather than an error (the shelf simply renders nothing).
        res.status(200).json({ drafts: [] });
        return;
      }
      try {
        const out = await deps.bus.call<
          ListAuthoredPendingInput,
          ListAuthoredPendingOutput
        >('connectors:list-authored-pending', ctx, { userId: actor.id });
        res.status(200).json({ drafts: out.drafts });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /**
     * POST /settings/connectors/authored/:id/approve — approve a pending authored
     * connector draft OUTSIDE chat (the Settings fallback for a missed/dismissed
     * card). Body `{ agentId, shown? }`. The user has already written the key to
     * their own vault (client-side, `setDestinationCredential`), exactly like the
     * in-chat card; this only triggers the grant.
     *
     * Security: `userId` is forced from the session; `agentId` comes from the
     * draft the client listed. We ACL-gate `agents:resolve(agentId, userId)` for
     * defense-in-depth (a user may only approve under an agent they can reach),
     * then call the orchestrator's `agent:apply-authored-connector-grant` with
     * NO conversationId (the approve-ahead path: writes approval rows, promotes
     * the draft into the registry, flips it active — no warm-session retire). The
     * grant re-resolves the agent's OWN drafts host-side, so an unknown / foreign
     * id is `not-authored` → 409 (nothing approved). No secret crosses this route.
     */
    async approveAuthored(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res);
      if (actor === null) return;
      const connectorId = req.params.id;
      if (typeof connectorId !== 'string' || connectorId.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      const parsed = parseAndValidateBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const raw = (parsed.value ?? {}) as Record<string, unknown>;
      const agentId = typeof raw.agentId === 'string' ? raw.agentId : '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      // `shown` is the same TOCTOU narrowing guard the in-chat card sends —
      // optional + forwarded verbatim; the grant intersects it with the
      // re-resolved proposal (it can only NARROW, never widen).
      const shown = raw.shown as
        | { hosts: string[]; slots: string[]; npm: string[]; pypi: string[] }
        | undefined;

      // Defense-in-depth ACL gate: the caller may only approve under an agent
      // they can reach. forbidden → 403, not-found → 404. Gated on the hook being
      // present (it always is in the k8s preset; a stripped preset skips the gate
      // and relies on the owner-scoped grant re-resolution below).
      if (deps.bus.hasService('agents:resolve')) {
        try {
          await deps.bus.call<AgentsResolveInputLike, unknown>('agents:resolve', ctx, {
            agentId,
            userId: actor.id,
          });
        } catch (err) {
          if (err instanceof PluginError) {
            if (err.code === 'forbidden') {
              res.status(403).json({ error: 'forbidden' });
              return;
            }
            res.status(404).json({ error: 'agent-not-found' });
            return;
          }
          throw err;
        }
      }

      if (!deps.bus.hasService('agent:apply-authored-connector-grant')) {
        res.status(409).json({ error: 'connector-grant-unavailable' });
        return;
      }
      try {
        const out = await deps.bus.call<
          ApplyAuthoredConnectorGrantInputLike,
          ApplyAuthoredConnectorGrantOutputLike
        >('agent:apply-authored-connector-grant', ctx, {
          userId: actor.id,
          agentId,
          connectorId,
          ...(shown !== undefined ? { shown } : {}),
          // conversationId intentionally omitted — approve-ahead (no live turn).
        });
        if (!out.applied) {
          // not-authored: the id isn't one of this (user, agent)'s pending drafts.
          res.status(409).json({ error: 'not-authored' });
          return;
        }
        res.status(200).json({ applied: true });
      } catch (err) {
        handleHookError(err, res);
      }
    },

    /**
     * DELETE /settings/connectors/authored/:id — DISMISS a pending authored
     * connector draft the assistant proposed (the "Proposed by your assistant"
     * shelf, 2026-06-04). Body `{ agentId }`. Before this route the only shelf
     * action was Approve, so the sole way to get rid of an unwanted proposal was
     * to approve it (entering a real or fake key to promote it into the registry)
     * and THEN delete it from the Connected shelf — a genuinely bad trap.
     *
     * Security: `userId` is forced from the session and the underlying
     * `connectors:clear-authored` deletes only rows scoped to `(ownerUserId,
     * agentId, connectorId)`, so a user can only ever dismiss their OWN draft —
     * a foreign / unknown (user, agent, connector) clears zero rows → 404.
     *
     * Deliberately NO `agents:resolve` ACL gate (unlike approve, which GRANTS
     * reach and must verify the caller can reach the agent). Dismissing your own
     * draft must work even when the authoring agent is gone or no longer
     * reachable — gating it would re-create the exact trap of an
     * un-dismissable orphan. No secret crosses this route.
     */
    async rejectAuthored(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authenticate(req, res);
      if (actor === null) return;
      const connectorId = req.params.id;
      if (typeof connectorId !== 'string' || connectorId.length === 0) {
        res.status(400).json({ error: 'missing-id' });
        return;
      }
      const parsed = parseAndValidateBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const raw = (parsed.value ?? {}) as Record<string, unknown>;
      const agentId = typeof raw.agentId === 'string' ? raw.agentId : '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      if (!deps.bus.hasService('connectors:clear-authored')) {
        // The preset doesn't expose authored drafts — nothing could have been
        // proposed, so there is nothing to dismiss.
        res.status(409).json({ error: 'connector-clear-unavailable' });
        return;
      }
      try {
        const out = await deps.bus.call<ClearAuthoredInput, ClearAuthoredOutput>(
          'connectors:clear-authored',
          ctx,
          { ownerUserId: actor.id, agentId, connectorId },
        );
        if (!out.cleared) {
          // No row matched (already gone, or not this owner's draft) — surface as
          // 404, the same leak posture as a foreign-owned read.
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
 * Register the admin routes against @ax/http-server. Returned unregister
 * callbacks should be tracked by the plugin and called on shutdown so a re-init
 * (tests) doesn't trip duplicate-route.
 */
export async function registerAdminConnectorRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createConnectorRouteHandlers({ bus, mode: 'admin' });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/connectors', handler: handlers.list },
    { method: 'POST', path: '/admin/connectors', handler: handlers.create },
    { method: 'GET', path: '/admin/connectors/:id', handler: handlers.show },
    { method: 'PATCH', path: '/admin/connectors/:id', handler: handlers.update },
    { method: 'DELETE', path: '/admin/connectors/:id', handler: handlers.destroy },
    { method: 'POST', path: '/admin/connectors/:id/test', handler: handlers.test },
    // TASK-737 — per-tool default permissions (editor-only; see handlers).
    {
      method: 'GET',
      path: '/admin/connectors/:id/tool-permissions',
      handler: handlers.toolPermissions,
    },
    {
      method: 'PUT',
      path: '/admin/connectors/:id/tool-permissions',
      handler: handlers.setToolPermissions,
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

/**
 * Register the `/settings/connectors` routes against @ax/http-server (TASK-129).
 * Slice 2a: READS and the authored-draft routes only. The writes (POST, PATCH,
 * DELETE, tool-permissions PUT) were removed: admins write connector definitions
 * via `/admin/connectors`, so those paths 404 for a non-admin.
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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/settings/connectors', handler: handlers.list },
    // The Settings "Proposed by your assistant" fallback: list the user's
    // pending authored drafts + approve one outside chat. Registered BEFORE the
    // `/:id` patterns so `authored` is never captured as an `:id`.
    {
      method: 'GET',
      path: '/settings/connectors/authored',
      handler: handlers.listAuthoredPending,
    },
    {
      method: 'POST',
      path: '/settings/connectors/authored/:id/approve',
      handler: handlers.approveAuthored,
    },
    {
      // Dismiss a proposed draft (no approve, no key) — reuses
      // `connectors:clear-authored`. The 4-segment path can't collide with the
      // 3-segment `DELETE /settings/connectors/:id` below, but it's grouped with
      // the other authored routes for clarity.
      method: 'DELETE',
      path: '/settings/connectors/authored/:id',
      handler: handlers.rejectAuthored,
    },
    { method: 'GET', path: '/settings/connectors/:id', handler: handlers.show },
    // Reads only: the agent rail's Add list, the key dialogs and the skill editor
    // read these as non-admins. Writes (POST/PATCH/DELETE, tool-permissions PUT)
    // are admin-only and live under `/admin/connectors`; they are NOT registered
    // here, so they 404 for everyone.
    {
      method: 'GET',
      path: '/settings/connectors/:id/tool-permissions',
      handler: handlers.toolPermissions,
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
