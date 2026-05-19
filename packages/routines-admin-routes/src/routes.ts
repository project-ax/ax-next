import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';
import {
  parseRequestBody,
  requireAdmin,
  requireUser,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// /settings/routines* — owner-scoped HTTP surface for the Routines admin UI.
//
// Three routes:
//
//   GET  /settings/routines
//   GET  /settings/routines/:agentId/fires?path=<routine-path>&limit=<n>
//   POST /settings/routines/:agentId/fire   { path, payload? }
//
// Every route:
//   1. Calls `auth:require-user` (401 if no session).
//   2. ACL-gates by calling `agents:resolve({ agentId, userId: actor.id })` —
//      if that throws (forbidden / not-found) the route returns 403. This is
//      the L8 enforcement: every entry point validates the owner before
//      reaching the routines facade.
//   3. Delegates to the routines service hooks.
//
// No cross-plugin imports per Invariant L2 — RouteRequest/RouteResponse are
// duck-typed in ./shared.js and the routines/agents shapes are inlined
// locally as zod schemas / generic types.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/routines-admin-routes';

/** POST /settings/routines/:agentId/fire body shape. Strict — extra fields
 *  reject so a confused client doesn't slip a `source` override past us. */
const fireBodySchema = z
  .object({
    path: z.string().min(1).max(512),
    payload: z.unknown().optional(),
  })
  .strict();

export interface AdminDeps {
  bus: HookBus;
}

/** AgentContext for a request executing on behalf of `actorId`. The sessionId
 *  is fixed (`routines-admin`) — these handlers are stateless from the bus's
 *  perspective, the value just shows up in logs. */
function ctxForActor(actorId: string): AgentContext {
  return makeAgentContext({
    sessionId: 'routines-admin',
    agentId: PLUGIN_NAME,
    userId: actorId,
  });
}

/** True if `userId` can resolve `agentId`. `agents:resolve` does the
 *  visibility/ACL check (owner OR team-member OR admin); a 'forbidden' or
 *  'not-found' PluginError means "no, you can't see this agent" and we
 *  return false. Any OTHER error (e.g. 'unauthenticated', 'no-service',
 *  'init-failed') means the bus or agents plugin is broken — we rethrow so
 *  `writeServiceError` / the http-server's 500 handler can map it instead
 *  of pretending it's a 403 and masking the real bug. */
async function isOwnedBy(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
): Promise<boolean> {
  try {
    await bus.call<{ agentId: string; userId: string }, unknown>(
      'agents:resolve',
      ctx,
      { agentId, userId },
    );
    return true;
  } catch (err) {
    if (
      err instanceof PluginError &&
      (err.code === 'forbidden' || err.code === 'not-found')
    ) {
      return false;
    }
    throw err;
  }
}

/** Inline (duck-typed) view of the routines list/recent-fires/fire-now
 *  service hook outputs — declared here rather than imported from @ax/routines
 *  per Invariant L2. Only the fields we relay to the client are typed; any
 *  extra fields on the wire pass through untouched. */
interface RoutineListItem {
  agentId: string;
}
interface RoutinesListOutput {
  routines: RoutineListItem[];
}
interface RoutinesRecentFiresOutput {
  fires: unknown[];
}
interface RoutinesFireNowOutput {
  fireId: number;
  status: string;
  conversationId: string | null;
}

export interface RoutinesAdminHandlers {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  fires: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  fire: (req: RouteRequest, res: RouteResponse) => Promise<void>;
}

export function createRoutinesAdminHandlers(
  deps: AdminDeps,
): RoutinesAdminHandlers {
  const initCtx = makeAgentContext({
    sessionId: 'routines-admin-init',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  return {
    async list(req, res) {
      const actor = await requireUser(deps.bus, initCtx, req, res);
      if (actor === null) return;
      const ctx = ctxForActor(actor.id);
      try {
        const out = await deps.bus.call<unknown, RoutinesListOutput>(
          'routines:list',
          ctx,
          {},
        );
        const visible: RoutineListItem[] = [];
        for (const r of out.routines) {
          if (await isOwnedBy(deps.bus, ctx, r.agentId, actor.id)) {
            visible.push(r);
          }
        }
        res.status(200).json({ routines: visible });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async fires(req, res) {
      const actor = await requireUser(deps.bus, initCtx, req, res);
      if (actor === null) return;
      const agentId = req.params.agentId;
      const path = req.query.path;
      const rawLimit = req.query.limit;
      // Validate `limit` BEFORE the bus call so a bad value (e.g.
      // ?limit=abc, ?limit=Infinity) fails fast as a 400 instead of
      // surfacing as a SQL `LIMIT NaN` runtime error inside the store's
      // clamp. The store still clamps to [1, 100] for defense in depth.
      let limit = 20;
      if (rawLimit !== undefined) {
        const parsed = Number(rawLimit);
        if (!Number.isFinite(parsed) || parsed < 1) {
          res
            .status(400)
            .json({ error: 'limit must be a positive integer' });
          return;
        }
        limit = Math.min(100, Math.trunc(parsed));
      }
      if (
        agentId === undefined ||
        agentId.length === 0 ||
        path === undefined ||
        path.length === 0
      ) {
        res.status(400).json({ error: 'agentId and ?path are required' });
        return;
      }
      const ctx = ctxForActor(actor.id);
      try {
        if (!(await isOwnedBy(deps.bus, ctx, agentId, actor.id))) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        const out = await deps.bus.call<
          { agentId: string; path: string; limit: number },
          RoutinesRecentFiresOutput
        >('routines:recent-fires', ctx, { agentId, path, limit });
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async fire(req, res) {
      const actor = await requireUser(deps.bus, initCtx, req, res);
      if (actor === null) return;
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const result = fireBodySchema.safeParse(parsedBody.value);
      if (!result.success) {
        const issue = result.error.issues[0];
        res
          .status(400)
          .json({ error: issue?.message ?? 'invalid body' });
        return;
      }
      const agentId = req.params.agentId;
      if (agentId === undefined || agentId.length === 0) {
        res.status(400).json({ error: 'agentId required' });
        return;
      }
      const ctx = ctxForActor(actor.id);
      try {
        if (!(await isOwnedBy(deps.bus, ctx, agentId, actor.id))) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        const input: {
          agentId: string;
          path: string;
          source: 'manual';
          payload?: unknown;
        } = {
          agentId,
          path: result.data.path,
          source: 'manual',
        };
        if (result.data.payload !== undefined) {
          input.payload = result.data.payload;
        }
        const out = await deps.bus.call<typeof input, RoutinesFireNowOutput>(
          'routines:fire-now',
          ctx,
          input,
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

/**
 * Mount the three /settings/routines* routes via `http:register-route`.
 * Returns the list of unregister callbacks (one per route) in registration
 * order — the plugin's `init` collects them so `shutdown` can unwind. If any
 * single registration throws, we unwind everything we already registered and
 * rethrow, so the plugin never leaves a half-mounted route surface behind.
 */
export async function registerRoutinesAdminRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createRoutinesAdminHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/settings/routines', handler: handlers.list },
    {
      method: 'GET',
      path: '/settings/routines/:agentId/fires',
      handler: handlers.fires,
    },
    {
      method: 'POST',
      path: '/settings/routines/:agentId/fire',
      handler: handlers.fire,
    },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<typeof route, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        route,
      );
      unregisters.push(result.unregister);
    }
  } catch (err) {
    while (unregisters.length > 0) {
      const fn = unregisters.pop();
      try {
        fn?.();
      } catch (unwindErr) {
        // best-effort unwind — log so a transport error in the unwinder
        // doesn't silently leave a dangling route handler behind. The
        // parent `err` is rethrown below; this is the diagnostic for the
        // unwind itself, which the operator may need to investigate.
        console.warn(
          `[${PLUGIN_NAME}] failed to unregister route during rollback: ${
            unwindErr instanceof Error ? unwindErr.message : String(unwindErr)
          }`,
        );
      }
    }
    throw err;
  }
  return unregisters;
}

// ---------------------------------------------------------------------------
// /admin/routines/defaults* — admin-only CRUD over the default_routines_v1
// table (the "library of templates" that materialize per-agent on tick).
//
// Five routes:
//
//   GET    /admin/routines/defaults          → list (DefaultRoutineSummary[])
//   GET    /admin/routines/defaults/:id      → detail (DefaultRoutineDetail)
//   POST   /admin/routines/defaults          → upsert via { sourceMd }
//   PUT    /admin/routines/defaults/:id      → upsert via { sourceMd }
//   DELETE /admin/routines/defaults/:id      → drop (cascades to per-agent)
//
// Every route gates on `auth:require-admin` (via requireAdmin) — these are
// fleet-wide changes, not per-user. There's no ACL check past "is this an
// admin"; the default_routines_v1 row has no owner field.
//
// Body shape on POST/PUT: `{ sourceMd: string }`, capped at 64 KiB to match
// the rest of the admin surface. The full SKILL.md-style frontmatter parse
// happens inside `routines:upsert-default`; we just relay the raw text. The
// routines plugin throws PluginError with codes
// `invalid-routine-md` / `default-trigger-webhook-not-supported` /
// `default-trigger-cron-not-supported` / `invalid-interval`, which
// `writeServiceError` maps to 400.
// ---------------------------------------------------------------------------

/** POST/PUT /admin/routines/defaults body. Strict — extra fields reject so
 *  a confused client doesn't slip an `enabled` override past us until the
 *  upsert hook itself accepts one. */
const upsertDefaultBodySchema = z
  .object({
    sourceMd: z.string().min(1).max(64 * 1024),
  })
  .strict();

interface DefaultRoutineSummaryWire {
  defaultRoutineId: string;
  name: string;
  description: string;
  trigger: unknown;
  enabled: boolean;
  updatedAt: string;
}

interface DefaultRoutinesListOutput {
  defaults: DefaultRoutineSummaryWire[];
}

interface DefaultRoutineDetailWire extends DefaultRoutineSummaryWire {
  sourceMd: string;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  activeHours: unknown | null;
  promptBody: string;
}

interface UpsertDefaultOutput {
  defaultRoutineId: string;
  created: boolean;
}

export interface AdminDefaultRoutinesHandlers {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  get: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  create: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  update: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy: (req: RouteRequest, res: RouteResponse) => Promise<void>;
}

export function createAdminDefaultRoutinesHandlers(
  deps: AdminDeps,
): AdminDefaultRoutinesHandlers {
  // Admin context — the actor binds at the per-request level via requireAdmin,
  // but the routines:*-default hooks don't ACL on userId (default routines
  // are fleet-wide). Keep a fixed admin ctx for the bus call so the
  // sessionId/agentId fields land usefully in logs.
  const adminCtx = makeAgentContext({
    sessionId: 'routines-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    async list(req, res) {
      const actor = await requireAdmin(deps.bus, adminCtx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<
          Record<string, never>,
          DefaultRoutinesListOutput
        >('routines:list-defaults', adminCtx, {});
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async get(req, res) {
      const actor = await requireAdmin(deps.bus, adminCtx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (id === undefined || id.length === 0) {
        res.status(400).json({ error: 'missing default routine id' });
        return;
      }
      try {
        const detail = await deps.bus.call<
          { defaultRoutineId: string },
          DefaultRoutineDetailWire
        >('routines:get-default', adminCtx, { defaultRoutineId: id });
        res.status(200).json(detail);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async create(req, res) {
      const actor = await requireAdmin(deps.bus, adminCtx, req, res);
      if (actor === null) return;
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const zodResult = upsertDefaultBodySchema.safeParse(parsedBody.value);
      if (!zodResult.success) {
        const first = zodResult.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      try {
        const out = await deps.bus.call<
          { sourceMd: string },
          UpsertDefaultOutput
        >('routines:upsert-default', adminCtx, {
          sourceMd: zodResult.data.sourceMd,
        });
        res
          .status(201)
          .json({ defaultRoutineId: out.defaultRoutineId, created: out.created });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async update(req, res) {
      const actor = await requireAdmin(deps.bus, adminCtx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (id === undefined || id.length === 0) {
        res.status(400).json({ error: 'missing default routine id' });
        return;
      }
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const zodResult = upsertDefaultBodySchema.safeParse(parsedBody.value);
      if (!zodResult.success) {
        const first = zodResult.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      try {
        const out = await deps.bus.call<
          { sourceMd: string },
          UpsertDefaultOutput
        >('routines:upsert-default', adminCtx, {
          sourceMd: zodResult.data.sourceMd,
        });
        // The PUT path identifies the row by id; if upsert returns a
        // different id, the client's URL and the body disagree on which
        // row this is. Surface that as 400 rather than silently writing
        // to the wrong row — mirrors @ax/skills admin handler.
        if (out.defaultRoutineId !== id) {
          res.status(400).json({
            error: 'default routine id in path does not match manifest name',
          });
          return;
        }
        res
          .status(200)
          .json({ defaultRoutineId: out.defaultRoutineId, created: out.created });
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    async destroy(req, res) {
      const actor = await requireAdmin(deps.bus, adminCtx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (id === undefined || id.length === 0) {
        res.status(400).json({ error: 'missing default routine id' });
        return;
      }
      try {
        await deps.bus.call<
          { defaultRoutineId: string },
          Record<string, never>
        >('routines:delete-default', adminCtx, { defaultRoutineId: id });
        res.status(204).end();
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

/**
 * Mount the five /admin/routines/defaults* routes via `http:register-route`.
 * Returns the list of unregister callbacks. Same unwind-on-partial-failure
 * shape as registerRoutinesAdminRoutes — never leaves a half-mounted route
 * surface behind (Invariant: no half-wired plugins).
 */
export async function registerAdminDefaultRoutinesRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminDefaultRoutinesHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    {
      method: 'GET',
      path: '/admin/routines/defaults',
      handler: handlers.list,
    },
    {
      method: 'GET',
      path: '/admin/routines/defaults/:id',
      handler: handlers.get,
    },
    {
      method: 'POST',
      path: '/admin/routines/defaults',
      handler: handlers.create,
    },
    {
      method: 'PUT',
      path: '/admin/routines/defaults/:id',
      handler: handlers.update,
    },
    {
      method: 'DELETE',
      path: '/admin/routines/defaults/:id',
      handler: handlers.destroy,
    },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<typeof route, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        route,
      );
      unregisters.push(result.unregister);
    }
  } catch (err) {
    while (unregisters.length > 0) {
      const fn = unregisters.pop();
      try {
        fn?.();
      } catch (unwindErr) {
        console.warn(
          `[${PLUGIN_NAME}] failed to unregister admin route during rollback: ${
            unwindErr instanceof Error ? unwindErr.message : String(unwindErr)
          }`,
        );
      }
    }
    throw err;
  }
  return unregisters;
}
