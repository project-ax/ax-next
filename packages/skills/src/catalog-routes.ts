import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type {
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
  CatalogAdmitInput,
  CatalogAdmitOutput,
} from './types.js';
import {
  requireAdmin,
  parseRequestBody,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './_routes-shared.js';

// ---------------------------------------------------------------------------
// /admin/catalog/* — admit-queue review routes (admin-only).
//
//   GET  /admin/catalog/requests                 → pending admit requests
//   POST /admin/catalog/requests/:id/decision    → admit | reject
//
// These FRONT the catalog:* service hooks (registered in plugin.ts, TASK-41).
// The deciding admin identity is the AUTHENTICATED actor — NEVER the request
// body (invariant I5; a client-supplied decidedByUserId is ignored).
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/skills';

// NOTE: `.strip()` (zod default), NOT `.strict()`. The route deliberately
// IGNORES any extra client-supplied fields — most importantly a spoofed
// `decidedByUserId` (invariant I5): the deciding identity always comes from
// the authenticated actor below, so an attacker who appends one is silently
// dropped rather than handed a 400 that would tell them the field is even
// inspected. We only require a valid `decision`.
const decisionBodySchema = z
  .object({ decision: z.enum(['admit', 'reject']) })
  .strip();

export interface CatalogRouteDeps {
  bus: HookBus;
}

export function createCatalogHandlers(deps: CatalogRouteDeps): {
  listRequests: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  decide: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'skills-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** GET /admin/catalog/requests */
    async listRequests(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
          'catalog:list-requests',
          ctx,
          { status: 'pending' },
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/catalog/requests/:id/decision */
    async decide(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing request id' });
        return;
      }
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const zr = decisionBodySchema.safeParse(parsedBody.value);
      if (!zr.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      try {
        const out = await deps.bus.call<CatalogAdmitInput, CatalogAdmitOutput>(
          'catalog:admit',
          ctx,
          {
            requestId: id,
            decision: zr.data.decision,
            decidedByUserId: actor.id, // host-supplied; body is ignored
          },
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

export async function registerCatalogRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createCatalogHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/catalog/requests', handler: handlers.listRequests },
    {
      method: 'POST',
      path: '/admin/catalog/requests/:id/decision',
      handler: handlers.decide,
    },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<unknown, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        route,
      );
      unregisters.push(result.unregister);
    }
  } catch (err) {
    // If a later route fails to register (e.g. duplicate path), unwind the
    // ones that already went live before rethrowing — otherwise this throws
    // before returning `unregisters` and the plugin-level catch can't reach
    // the already-registered route, leaking it. (registerAdminSkillsRoutes and
    // registerSettingsSkillsRoutes apply the same unwind — TASK-58.)
    while (unregisters.length > 0) {
      const fn = unregisters.pop();
      try {
        fn?.();
      } catch {
        // best-effort unwind
      }
    }
    throw err;
  }
  return unregisters;
}
