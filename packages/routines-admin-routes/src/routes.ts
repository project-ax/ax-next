import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import {
  parseRequestBody,
  requireAdmin,
  requireUser,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';
const PLUGIN_NAME = '@ax/routines-admin-routes';
export interface AdminDeps {
  bus: HookBus;
}
type Handler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
const authContext = () =>
  makeAgentContext({
    sessionId: 'routines-auth',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });
const actorContext = (userId: string, agentId = PLUGIN_NAME) =>
  makeAgentContext({ sessionId: 'routines-settings', agentId, userId });
const consentSchema = z
  .object({ enabled: z.boolean(), revision: C.RoutineOpaqueStringSchema })
  .strict();

function body<T>(
  req: RouteRequest,
  res: RouteResponse,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T | undefined {
  const raw = parseRequestBody(req.body);
  if (!raw.ok) {
    res
      .status(raw.status)
      .json({ code: 'validation', field: 'input', error: raw.message });
    return;
  }
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) {
    res.status(400).json({
      code: 'validation',
      field: 'input',
      error: 'Routine input is invalid.',
    });
    return;
  }
  return parsed.data;
}
function key(req: RouteRequest, res: RouteResponse, item: boolean) {
  const parsed = (
    item ? C.RoutineKeySchema : C.RoutineListInputSchema
  ).safeParse(
    item
      ? { agentId: req.params.agentId, routineId: req.params.routineId }
      : { agentId: req.params.agentId },
  );
  if (!parsed.success) {
    res.status(400).json({
      code: 'validation',
      field: 'input',
      error: 'Routine input is invalid.',
    });
    return;
  }
  return parsed.data;
}
/** HTTP identity is always the authenticated person; a team ID is never an actor. */
function scoped(
  deps: AdminDeps,
  effect: (
    req: RouteRequest,
    res: RouteResponse,
    ctx: AgentContext,
  ) => Promise<void>,
): Handler {
  return async (req, res) => {
    const actor = await requireUser(deps.bus, authContext(), req, res);
    if (!actor) return;
    const input = key(req, res, false);
    if (!input) return;
    try {
      await effect(req, res, actorContext(actor.id, input.agentId));
    } catch (error) {
      writeServiceError(res, error);
    }
  };
}
/**
 * TASK-957. Settings shows a routine, never a task's state. A task's report
 * (its update, ask, reading and notes), its steps and each run's report are
 * the agent's text (a step can be a person's too, in the same list). The task
 * page reads them through channel-web's workspace routes, which fence and cap
 * every line, and Settings draws none of them. So every Settings answer leaves
 * them out, with the values the services already give anyone but the task's
 * owner: `task` null, `steps` empty, a run's `report` null. Each answer still
 * parses as the contract's view, which is what the SPA types it as. What the
 * host writes (missed check-ins, when the task was marked done) and the
 * person's finish date and the zone it was set from (TASK-955) stay.
 */
function settingsView(view: C.RoutineView): C.RoutineView {
  return { ...view, task: null, steps: [] };
}
function settingsFire(fire: C.RoutineFireView): C.RoutineFireView {
  return { ...fire, report: null };
}
export function createRoutinesAdminHandlers(deps: AdminDeps) {
  const call = async <T>(
    hook: string,
    ctx: AgentContext,
    input: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ) => schema.parse(await deps.bus.call(hook, ctx, input));
  const item = (req: RouteRequest, res: RouteResponse) =>
    key(req, res, true) as C.RoutineKey | undefined;
  return {
    list: scoped(deps, async (req, res, ctx) => {
      const input = key(req, res, false);
      if (input)
        res.status(200).json({
          routines: (
            await call('routines:list', ctx, input, C.RoutineListOutputSchema)
          ).routines.map(settingsView),
        });
    }),
    get: scoped(deps, async (req, res, ctx) => {
      const input = item(req, res);
      if (input)
        res.status(200).json({
          routine: settingsView(
            await call('routines:get', ctx, input, C.RoutineGetOutputSchema),
          ),
        });
    }),
    create: scoped(deps, async (req, res, ctx) => {
      const input = body(
        req,
        res,
        C.RoutineCreateInputSchema.omit({ agentId: true }),
      );
      if (input)
        res.status(201).json({
          routine: settingsView(
            await call(
              'routines:create',
              ctx,
              { ...input, agentId: ctx.agentId },
              C.RoutineCreateOutputSchema,
            ),
          ),
        });
    }),
    update: scoped(deps, async (req, res, ctx) => {
      const input = body(
        req,
        res,
        C.RoutineUpdateInputSchema.omit({ agentId: true, routineId: true }),
      );
      if (!input) return;
      const k = item(req, res);
      if (k)
        res.status(200).json({
          routine: settingsView(
            await call(
              'routines:update',
              ctx,
              { ...input, ...k },
              C.RoutineUpdateOutputSchema,
            ),
          ),
        });
    }),
    destroy: scoped(deps, async (req, res, ctx) => {
      const input = body(
        req,
        res,
        C.RoutineDeleteInputSchema.omit({ agentId: true, routineId: true }),
      );
      if (!input) return;
      const k = item(req, res);
      if (k)
        res
          .status(200)
          .json(
            await call(
              'routines:delete',
              ctx,
              { ...input, ...k },
              C.RoutineDeleteOutputSchema,
            ),
          );
    }),
    fire: scoped(deps, async (req, res, ctx) => {
      const input = body(
        req,
        res,
        C.RoutineFireNowInputSchema.omit({ agentId: true, routineId: true }),
      );
      if (!input) return;
      const k = item(req, res);
      if (k)
        res
          .status(200)
          .json(
            await call(
              'routines:fire-now',
              ctx,
              { ...input, ...k },
              C.RoutineFireNowOutputSchema,
            ),
          );
    }),
    fires: scoped(deps, async (req, res, ctx) => {
      const k = item(req, res);
      if (!k) return;
      const limit =
        req.query.limit === undefined ? 20 : Number(req.query.limit);
      const parsed = C.RoutineRecentFiresInputSchema.safeParse({ ...k, limit });
      if (!parsed.success) {
        res.status(400).json({
          code: 'validation',
          field: 'input',
          error: 'Invalid history limit.',
        });
        return;
      }
      res.status(200).json({
        fires: (
          await call(
            'routines:recent-fires',
            ctx,
            parsed.data,
            C.RoutineRecentFiresOutputSchema,
          )
        ).fires.map(settingsFire),
      });
    }),
    consent: scoped(deps, async (_req, res, ctx) =>
      res
        .status(200)
        .json(
          await call(
            'tool-policy:get-routine-consent',
            ctx,
            { agentId: ctx.agentId },
            consentSchema,
          ),
        ),
    ),
    revokeConsent: scoped(deps, async (req, res, ctx) => {
      if (body(req, res, z.object({}).strict()))
        res
          .status(200)
          .json(
            await call(
              'tool-policy:revoke-routine-consent',
              ctx,
              { agentId: ctx.agentId },
              consentSchema,
            ),
          );
    }),
    receiverAccess: async (req: RouteRequest, res: RouteResponse) => {
      const actor = await requireUser(deps.bus, authContext(), req, res);
      if (!actor) return;
      const input = key(req, res, false);
      if (!input) return;
      const ctx = actorContext(actor.id, input.agentId);
      try {
        await deps.bus.call('agents:resolve', ctx, { agentId: input.agentId, userId: actor.id });
        // The existing agent-management predicate also guards receiver tokens.
        // This read checks authority only: it never obtains or creates a token.
        const out = await call('agents:can-manage-connectors', ctx, {
          agentId: input.agentId, actor: { userId: actor.id, isAdmin: actor.isAdmin },
        }, z.object({ allowed: z.boolean() }).strict());
        res.status(200).json(out);
      } catch (error) {
        writeServiceError(res, error);
      }
    },
    receiver: async (req: RouteRequest, res: RouteResponse) => {
      const actor = await requireUser(deps.bus, authContext(), req, res);
      if (!actor) return;
      const input = key(req, res, false);
      if (!input) return;
      const ctx = actorContext(actor.id, input.agentId);
      try {
        await deps.bus.call('agents:resolve', ctx, {
          agentId: input.agentId,
          userId: actor.id,
        });
        const out = await call(
          'agents:ensure-webhook-token',
          ctx,
          {
            agentId: input.agentId,
            actor: { userId: actor.id, isAdmin: actor.isAdmin },
          },
          z.object({ token: z.string().min(1).max(256) }).strict(),
        );
        res
          .status(200)
          .json({ url: `/webhooks/${encodeURIComponent(out.token)}` });
      } catch (error) {
        writeServiceError(res, error);
      }
    },
  };
}
export type RoutinesAdminHandlers = ReturnType<
  typeof createRoutinesAdminHandlers
>;
async function register(
  bus: HookBus,
  ctx: AgentContext,
  routes: Array<{ method: string; path: string; handler: Handler }>,
) {
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const out = await bus.call<typeof route, { unregister: () => void }>(
        'http:register-route',
        ctx,
        route,
      );
      unregisters.push(out.unregister);
    }
  } catch (error) {
    for (const unregister of unregisters.reverse()) {
      try {
        unregister();
      } catch {
        console.warn('Routine route rollback failed.');
      }
    }
    throw error;
  }
  return unregisters;
}
export async function registerRoutinesAdminRoutes(
  bus: HookBus,
  ctx: AgentContext,
) {
  const h = createRoutinesAdminHandlers({ bus });
  const base = '/settings/routines/:agentId';
  return register(bus, ctx, [
    { method: 'GET', path: `${base}/consent`, handler: h.consent },
    { method: 'DELETE', path: `${base}/consent`, handler: h.revokeConsent },
    { method: 'GET', path: `${base}/receiver`, handler: h.receiver },
    { method: 'GET', path: `${base}/receiver-access`, handler: h.receiverAccess },
    { method: 'GET', path: base, handler: h.list },
    { method: 'POST', path: base, handler: h.create },
    { method: 'GET', path: `${base}/:routineId`, handler: h.get },
    { method: 'PATCH', path: `${base}/:routineId`, handler: h.update },
    { method: 'DELETE', path: `${base}/:routineId`, handler: h.destroy },
    { method: 'POST', path: `${base}/:routineId/fire`, handler: h.fire },
    { method: 'GET', path: `${base}/:routineId/fires`, handler: h.fires },
  ]);
}
export function createSettingsAgentDefaultsHandlers(deps: AdminDeps) {
  return {
    list: scoped(deps, async (_req, res, ctx) =>
      res.status(200).json(
        C.RoutineListAgentDefaultsOutputSchema.parse(
          await deps.bus.call('routines:list-agent-defaults', ctx, {
            agentId: ctx.agentId,
          }),
        ),
      ),
    ),
    set: scoped(deps, async (req, res, ctx) => {
      const input = body(
        req,
        res,
        C.RoutineSetAgentDefaultEnabledInputSchema.omit({
          agentId: true,
          defaultRoutineId: true,
        }),
      );
      if (!input) return;
      const parsed = C.RoutineSetAgentDefaultEnabledInputSchema.safeParse({
        ...input,
        agentId: ctx.agentId,
        defaultRoutineId: req.params.defaultRoutineId,
      });
      if (!parsed.success) {
        res.status(400).json({
          code: 'validation',
          field: 'input',
          error: 'Invalid default routine.',
        });
        return;
      }
      C.RoutineSetAgentDefaultEnabledOutputSchema.parse(
        await deps.bus.call(
          'routines:set-agent-default-enabled',
          ctx,
          parsed.data,
        ),
      );
      res.status(200).json({ ok: true });
    }),
  };
}
export type SettingsAgentDefaultsHandlers = ReturnType<
  typeof createSettingsAgentDefaultsHandlers
>;
export async function registerSettingsAgentDefaultsRoutes(
  bus: HookBus,
  ctx: AgentContext,
) {
  const h = createSettingsAgentDefaultsHandlers({ bus });
  return register(bus, ctx, [
    {
      method: 'GET',
      path: '/settings/routines/:agentId/defaults',
      handler: h.list,
    },
    {
      method: 'POST',
      path: '/settings/routines/:agentId/defaults/:defaultRoutineId',
      handler: h.set,
    },
  ]);
}
function admin(
  deps: AdminDeps,
  effect: (
    req: RouteRequest,
    res: RouteResponse,
    ctx: AgentContext,
  ) => Promise<void>,
): Handler {
  return async (req, res) => {
    const actor = await requireAdmin(deps.bus, authContext(), req, res);
    if (!actor) return;
    try {
      await effect(req, res, actorContext(actor.id));
    } catch (error) {
      writeServiceError(res, error);
    }
  };
}
function defaultKey(req: RouteRequest, res: RouteResponse) {
  const parsed = C.RoutineGetDefaultInputSchema.safeParse({
    defaultRoutineId: req.params.id,
  });
  if (!parsed.success) {
    res.status(400).json({
      code: 'validation',
      field: 'routineId',
      error: 'Invalid default routine.',
    });
    return;
  }
  return parsed.data;
}
export function createAdminDefaultRoutinesHandlers(deps: AdminDeps) {
  const save = async (
    req: RouteRequest,
    res: RouteResponse,
    ctx: AgentContext,
    update: boolean,
  ) => {
    const input = body(req, res, C.RoutineUpsertDefaultInputSchema);
    if (!input) return;
    if (update) {
      const k = defaultKey(req, res);
      if (!k) return;
      const existing = C.RoutineGetDefaultOutputSchema.parse(
        await deps.bus.call('routines:get-default', ctx, k),
      );
      if (existing.name !== input.name) {
        res.status(400).json({
          code: 'validation',
          field: 'name',
          error: 'The default routine name must stay unchanged.',
        });
        return;
      }
    }
    const out = C.RoutineUpsertDefaultOutputSchema.parse(
      await deps.bus.call('routines:upsert-default', ctx, input),
    );
    res.status(update ? 200 : 201).json(out);
  };
  return {
    list: admin(deps, async (_req, res, ctx) =>
      res
        .status(200)
        .json(
          C.RoutineListDefaultsOutputSchema.parse(
            await deps.bus.call('routines:list-defaults', ctx, {}),
          ),
        ),
    ),
    get: admin(deps, async (req, res, ctx) => {
      const k = defaultKey(req, res);
      if (k)
        res
          .status(200)
          .json(
            C.RoutineGetDefaultOutputSchema.parse(
              await deps.bus.call('routines:get-default', ctx, k),
            ),
          );
    }),
    create: admin(deps, (req, res, ctx) => save(req, res, ctx, false)),
    update: admin(deps, (req, res, ctx) => save(req, res, ctx, true)),
    destroy: admin(deps, async (req, res, ctx) => {
      const k = defaultKey(req, res);
      if (k) {
        C.RoutineDeleteDefaultOutputSchema.parse(
          await deps.bus.call('routines:delete-default', ctx, k),
        );
        res.status(204).end();
      }
    }),
  };
}
export type AdminDefaultRoutinesHandlers = ReturnType<
  typeof createAdminDefaultRoutinesHandlers
>;
export async function registerAdminDefaultRoutinesRoutes(
  bus: HookBus,
  ctx: AgentContext,
) {
  const h = createAdminDefaultRoutinesHandlers({ bus });
  const base = '/admin/routines/defaults';
  return register(bus, ctx, [
    { method: 'GET', path: base, handler: h.list },
    { method: 'GET', path: `${base}/:id`, handler: h.get },
    { method: 'POST', path: base, handler: h.create },
    { method: 'PUT', path: `${base}/:id`, handler: h.update },
    { method: 'DELETE', path: `${base}/:id`, handler: h.destroy },
  ]);
}
