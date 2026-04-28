import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';
import type {
  Actor,
  Agent,
  AgentInput,
  CreateInput,
  CreateOutput,
  DeleteInput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
  UpdateOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// HTTP route handlers for /admin/agents[/:id].
//
// Routes are registered on @ax/http-server via http:register-route in
// plugin.init. Handlers here duck-type the request/response surface
// (Invariant I2 — no @ax/http-server import) so a future non-HTTP transport
// could provide it.
//
// ALL endpoints:
//   - require a valid signed session cookie (auth:require-user) — 401 if not
//   - cap the request body at 64 KiB BEFORE zod-parsing — 413 if over
//   - validate the body via zod and collapse error paths into a single
//     user-friendly message — raw zod paths are NEVER echoed to the client
//   - delegate to the existing agents:* service hooks for ACL + persistence
//
// Wildcard tool scope (allowedTools=[] AND mcpConfigIds=[] together) is
// REJECTED here, NOT in store.ts. The store still allows the wildcard
// shape so dev-agents-stub can register pass-through filters at boot.
// Production agents created via THIS API path must not be able to
// silently bypass the per-agent tool catalog filter.
// ---------------------------------------------------------------------------

/** Locked at handler entry — wider than the store's 32 KiB system_prompt cap
 *  to leave room for the JSON envelope, headers, and a generous margin for
 *  the longest possible allowedTools / mcpConfigIds + display_name combo.
 *  Smaller than http-server's 1 MiB so the admin API doesn't accept blobs
 *  the storage layer can't hold. */
export const ADMIN_BODY_MAX_BYTES = 64 * 1024;

const PLUGIN_NAME = '@ax/agents';

// --- duck-typed request/response (mirrors @ax/http-server's HttpRequest /
// HttpResponse minus the import) -------------------------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/admin/agents/:id`. Empty for collection routes. */
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

// --- zod schemas -----------------------------------------------------------

// These mirror the store.ts validators (one-source-of-truth lives in the
// store; this layer's job is to reject malformed JSON shape and the
// wildcard-bypass case before the bus call). Keeping the regex / length
// caps in lockstep is a manual maintenance task — if store.ts loosens, this
// layer stays strict. Drift in the OTHER direction (this layer accepts
// what the store rejects) gets caught by the hook impl and surfaces as
// invalid-payload at runtime.
const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MCP_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const WORKSPACE_REF_RE = /^[A-Za-z0-9_./-]+$/;

const displayNameSchema = z
  .string()
  .min(1, 'displayName must be 1-128 chars')
  .max(128, 'displayName must be 1-128 chars')
  .refine(
    (s) => s === s.trim(),
    'displayName must not have leading or trailing whitespace',
  );

const systemPromptSchema = z
  .string()
  .max(32 * 1024, 'systemPrompt must be at most 32 KiB');

const allowedToolsSchema = z
  .array(z.string().regex(TOOL_NAME_RE, 'allowedTools entry has invalid shape'))
  .max(100, 'allowedTools must have at most 100 entries');

const mcpConfigIdsSchema = z
  .array(z.string().regex(MCP_ID_RE, 'mcpConfigIds entry has invalid shape'))
  .max(50, 'mcpConfigIds must have at most 50 entries');

const modelSchema = z.string().min(1, 'model must be a non-empty string');

const visibilitySchema = z.enum(['personal', 'team']);

const teamIdSchema = z.string().min(1).max(128);

const workspaceRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(WORKSPACE_REF_RE, 'workspaceRef has invalid shape')
  .nullable();

/**
 * Body schema for `POST /admin/agents`. Matches AgentInput exactly so the
 * shape passes through `agents:create` without further translation.
 *
 * `visibility:'team'` requires teamId — checked via .superRefine because
 * the field is conditionally required.
 */
const createBodySchema = z
  .object({
    displayName: displayNameSchema,
    systemPrompt: systemPromptSchema,
    allowedTools: allowedToolsSchema,
    mcpConfigIds: mcpConfigIdsSchema,
    model: modelSchema,
    visibility: visibilitySchema,
    teamId: teamIdSchema.optional(),
    workspaceRef: workspaceRefSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.visibility === 'team' && value.teamId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "teamId is required when visibility='team'",
        path: ['teamId'],
      });
    }
    if (value.visibility === 'personal' && value.teamId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "teamId must not be set when visibility='personal'",
        path: ['teamId'],
      });
    }
  });

/**
 * Body schema for `PATCH /admin/agents/:id`. Same field shapes as create
 * but every field is optional. visibility/teamId cannot be patched (the
 * store rejects them anyway — checked here too so the error message is
 * crisp).
 */
const updateBodySchema = z
  .object({
    displayName: displayNameSchema.optional(),
    systemPrompt: systemPromptSchema.optional(),
    allowedTools: allowedToolsSchema.optional(),
    mcpConfigIds: mcpConfigIdsSchema.optional(),
    model: modelSchema.optional(),
    workspaceRef: workspaceRefSchema.optional(),
  })
  .strict();

// --- helpers ---------------------------------------------------------------

/**
 * Try to authenticate. Returns the user on success, null on failure (we
 * already wrote the 401). Mirrors @ax/auth's admin-routes pattern: the
 * check is inline, not a wrapper, so each handler has explicit control
 * over its response shape.
 */
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
    // PluginError 'unauthenticated' is the documented rejection; any
    // other failure (e.g. auth plugin not loaded) returns 401 too —
    // an admin endpoint that can't authenticate is closed by default.
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
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

/**
 * Body parsing pipeline. Returns either a parsed value or an error
 * descriptor whose `status`/`message` the caller writes verbatim. Order:
 *   1. 413 on body > ADMIN_BODY_MAX_BYTES (the http-server's own 1 MiB
 *      cap is wider; we tighten here for the admin surface).
 *   2. 400 on JSON.parse failure.
 *   3. 400 on zod validation failure (collapsed to one message; raw zod
 *      issue paths are NOT echoed — they can leak internal field names
 *      and confuse callers).
 *   4. 400 on the wildcard-bypass case (allowedTools=[] AND mcpConfigIds=[]).
 */
function parseAndValidate<T extends z.ZodTypeAny>(
  body: Buffer,
  schema: T,
): ParsedBody<z.infer<T>> | ParseError {
  if (body.length > ADMIN_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  let raw: unknown;
  try {
    raw = parseJsonBody(body);
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    // first message wins; never expose `path` (some are internal-shape
    // names that leak which Zod refinement triggered).
    return {
      ok: false,
      status: 400,
      message:
        first?.message !== undefined && first.message.length > 0
          ? first.message
          : 'invalid-payload',
    };
  }
  return { ok: true, value: result.data };
}

function rejectsWildcardScope(input: {
  allowedTools?: string[] | undefined;
  mcpConfigIds?: string[] | undefined;
}): boolean {
  // Both arrays must be PRESENT and EMPTY to trigger. This matches the
  // dev-agents-stub bypass shape (Task 7) — that path is allowed at the
  // store layer but forbidden via this admin API. A PATCH that omits
  // both fields stays unaffected; a PATCH that sets both to [] hits this.
  return (
    input.allowedTools !== undefined &&
    input.allowedTools.length === 0 &&
    input.mcpConfigIds !== undefined &&
    input.mcpConfigIds.length === 0
  );
}

const WILDCARD_REJECT_MESSAGE =
  'agent must list at least one tool or one MCP config; empty arrays are reserved for dev-mode bypass';

function serializeAgent(a: Agent): Record<string, unknown> {
  // Date → ISO 8601 strings. The HTTP wire is JSON; Date doesn't serialize
  // cleanly through res.json otherwise (becomes "" via JSON.stringify of
  // Date prototype-mangled paths in some test environments). Be explicit.
  return {
    id: a.id,
    ownerId: a.ownerId,
    ownerType: a.ownerType,
    visibility: a.visibility,
    displayName: a.displayName,
    systemPrompt: a.systemPrompt,
    allowedTools: a.allowedTools,
    mcpConfigIds: a.mcpConfigIds,
    model: a.model,
    workspaceRef: a.workspaceRef,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/**
 * Translate a service-hook PluginError into an HTTP status. `forbidden`
 * → 403, `not-found` → 404, `invalid-payload` → 400, anything else →
 * 500 (logged at the http-server's catch-all).
 */
function writeServiceError(res: RouteResponse, err: unknown): boolean {
  if (err instanceof PluginError) {
    if (err.code === 'forbidden') {
      res.status(403).json({ error: 'forbidden' });
      return true;
    }
    if (err.code === 'not-found') {
      res.status(404).json({ error: 'not-found' });
      return true;
    }
    if (err.code === 'invalid-payload') {
      res.status(400).json({ error: err.message });
      return true;
    }
  }
  return false;
}

// --- handler factory -------------------------------------------------------

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminAgentRouteHandlers(deps: AdminRouteDeps) {
  // A per-handler ctx is acceptable for MVP (Task 9 spec). A subscriber
  // observing audit events sees `userId: 'admin'` in the ctx — the actual
  // acting-user id is in the agents:resolved subscriber payload, which is
  // what audit consumers should key off. Documented in the plan.
  const ctx = makeAgentContext({
    sessionId: 'agents-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** POST /admin/agents */
    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;

      const parsed = parseAndValidate(req.body, createBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      if (rejectsWildcardScope(parsed.value)) {
        res.status(400).json({ error: WILDCARD_REJECT_MESSAGE });
        return;
      }
      // The zod schema guarantees the AgentInput shape; cast through unknown
      // because exactOptionalPropertyTypes treats omitted-vs-explicit-undefined
      // differently between the schema's inferred shape and AgentInput's
      // declared optional fields. Runtime payload is identical.
      const input = parsed.value as unknown as AgentInput;
      try {
        const out = await deps.bus.call<CreateInput, CreateOutput>(
          'agents:create',
          ctx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
            input,
          },
        );
        res.status(201).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** GET /admin/agents */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      // TODO Task 14: pass teamIds: await listTeamsForUser(actor.id) so
      // team agents the user belongs to surface here. Until @ax/teams
      // ships, this list returns personal agents only (the store's
      // scope filter accepts an empty teamIds list and only matches
      // owner_type='user' rows).
      const out = await deps.bus.call<ListForUserInput, ListForUserOutput>(
        'agents:list-for-user',
        ctx,
        { userId: actor.id },
      );
      res.status(200).json({ agents: out.agents.map(serializeAgent) });
    },

    /** GET /admin/agents/:id */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      try {
        const out = await deps.bus.call<ResolveInput, ResolveOutput>(
          'agents:resolve',
          ctx,
          { agentId, userId: actor.id },
        );
        res.status(200).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** PATCH /admin/agents/:id */
    async update(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const parsed = parseAndValidate(req.body, updateBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      if (rejectsWildcardScope(parsed.value)) {
        res.status(400).json({ error: WILDCARD_REJECT_MESSAGE });
        return;
      }
      try {
        const out = await deps.bus.call<UpdateInput, UpdateOutput>(
          'agents:update',
          ctx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
            agentId,
            patch: parsed.value as Partial<AgentInput>,
          },
        );
        res.status(200).json({ agent: serializeAgent(out.agent) });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** DELETE /admin/agents/:id */
    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      const agentId = req.params.id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      try {
        await deps.bus.call<DeleteInput, void>('agents:delete', ctx, {
          actor: { userId: actor.id, isAdmin: actor.isAdmin } satisfies Actor,
          agentId,
        });
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

/**
 * Register all five admin routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called in
 * shutdown so a re-init in tests doesn't trip duplicate-route.
 */
export async function registerAdminAgentRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminAgentRouteHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'POST', path: '/admin/agents', handler: handlers.create },
    { method: 'GET', path: '/admin/agents', handler: handlers.list },
    { method: 'GET', path: '/admin/agents/:id', handler: handlers.show },
    { method: 'PATCH', path: '/admin/agents/:id', handler: handlers.update },
    { method: 'DELETE', path: '/admin/agents/:id', handler: handlers.destroy },
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
