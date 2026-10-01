import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { Catalog } from './catalog.js';
import type { PolicyStore } from './policy-store.js';
import {
  POLICY_BODY_MAX_BYTES,
  parseRequestBody,
  requireAdmin,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

export interface RouteHandlers {
  catalog(req: RouteRequest, res: RouteResponse): Promise<void>;
  getPolicy(req: RouteRequest, res: RouteResponse): Promise<void>;
  putPolicy(req: RouteRequest, res: RouteResponse): Promise<void>;
}

const putBodySchema = z
  .object({
    baseVersion: z.number().int().min(0),
    allowed: z.unknown(),
    default: z.unknown(),
  })
  .strict();

export function createHandlers(deps: { bus: HookBus; store: PolicyStore; catalog: Catalog }): RouteHandlers {
  // Run every request as the admin who made it, without an agent scope: these
  // are deployment settings, not an agent operation. credentials:get skips an
  // empty agentId and resolves the admin's key, then the global key. Using the
  // plugin name here causes an invalid agent-owner lookup before global scope.
  const ctxFor = (userId: string): AgentContext =>
    makeAgentContext({ sessionId: 'model-policy', agentId: '', userId });

  return {
    async catalog(req, res) {
      const actor = await requireAdmin(deps.bus, ctxFor('system'), req, res);
      if (actor === null) return;
      const result = await deps.catalog.get(ctxFor(actor.id), { refresh: req.query.refresh === '1' });
      res.status(200).json(result);
    },

    async getPolicy(req, res) {
      const actor = await requireAdmin(deps.bus, ctxFor('system'), req, res);
      if (actor === null) return;
      res.status(200).json(await deps.store.read(ctxFor(actor.id)));
    },

    async putPolicy(req, res) {
      const actor = await requireAdmin(deps.bus, ctxFor('system'), req, res);
      if (actor === null) return;
      const body = parseRequestBody(req.body);
      if (!body.ok) {
        res.status(body.status).json({ error: body.message });
        return;
      }
      const shape = putBodySchema.safeParse(body.value);
      if (!shape.success) {
        res.status(400).json({ error: 'invalid-payload', message: 'baseVersion must be a whole number of 0 or more' });
        return;
      }
      const result = await deps.store.save(ctxFor(actor.id), { baseVersion: shape.data.baseVersion, allowed: shape.data.allowed, default: shape.data.default }, actor.id);
      if (result.ok) {
        res.status(200).json(result.policy);
        return;
      }
      if (result.code === 'stale-version') {
        res.status(409).json({ error: 'stale-version' });
        return;
      }
      res.status(400).json({ error: result.code, message: result.message });
    },
  };
}

interface RouteSpec {
  method: 'GET' | 'PUT';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

/** Register the three routes. Returns the unregister callbacks; on a partial failure it unwinds what it registered. */
export async function registerModelPolicyRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  handlers: RouteHandlers,
): Promise<Array<() => void>> {
  const routes: RouteSpec[] = [
    { method: 'GET', path: '/admin/models/catalog', handler: handlers.catalog },
    { method: 'GET', path: '/admin/models/policy', handler: handlers.getPolicy },
    { method: 'PUT', path: '/admin/models/policy', handler: handlers.putPolicy, maxBodyBytes: POLICY_BODY_MAX_BYTES },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<RouteSpec, { unregister: () => void }>('http:register-route', initCtx, route);
      unregisters.push(result.unregister);
    }
  } catch (err) {
    while (unregisters.length > 0) {
      try {
        unregisters.pop()?.();
      } catch {
        /* best effort while unwinding */
      }
    }
    throw err;
  }
  return unregisters;
}
