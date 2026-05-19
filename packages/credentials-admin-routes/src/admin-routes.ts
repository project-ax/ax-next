import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import {
  requireAdmin,
  requireUser,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

// ---------------------------------------------------------------------------
// /admin/credentials* read-only handlers (admin-only, except kinds).
//
// Routes:
//   GET    /admin/credentials                                  → list (metadata only)
//   GET    /admin/credentials/kinds                            → kinds catalog
//
// Write operations (create/destroy) have been removed in the credentials UX
// redesign — the new UI submits credentials via the destination-routes wire
// surface instead (Task 9). These two GET routes are kept because the new
// UI's status pill polls them to show configured/unconfigured state.
//
// `/admin/credentials/kinds` (the kinds catalog) is mounted under the
// admin namespace for routing convenience but the auth gate is relaxed
// to `auth:require-user` — the catalog isn't admin-sensitive (it just
// answers "what flows does this deployment support?").
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/credentials-admin-routes';

export interface AdminRouteDeps {
  bus: HookBus;
}

export function createAdminCredentialsHandlers(deps: AdminRouteDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  kinds: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  // Per-handler ctx is acceptable for MVP. A subscriber observing audit
  // events sees `userId: 'admin'` in the ctx — the actual acting-user id
  // is communicated via subscriber payloads (which Phase 6 will add for
  // credentials).
  const ctx = makeAgentContext({
    sessionId: 'credentials-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** GET /admin/credentials */
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<
          Record<string, never>,
          { credentials: unknown[] }
        >('credentials:list', ctx, {});
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /**
     * GET /admin/credentials/kinds — catalog of supported credential
     * kinds and their flow shape (paste vs oauth). Auth gate is relaxed
     * to any authed user (settings UI consumes the same route).
     */
    async kinds(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<
          Record<string, never>,
          { kinds: Array<{ kind: string; flow: string }> }
        >('credentials:list-kinds', ctx, {});
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

/**
 * Register the two read-only admin routes against @ax/http-server. Returned
 * unregister callbacks should be tracked by the plugin and called on
 * shutdown so a re-init in tests doesn't trip duplicate-route.
 */
export async function registerAdminCredentialsRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createAdminCredentialsHandlers({ bus });
  const routes: Array<{
    method: 'GET';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/credentials', handler: handlers.list },
    // `/admin/credentials/kinds` is a literal route — exact-match dispatch
    // in @ax/http-server's router wins over parameterised patterns
    // regardless of registration order, but we list it first for readability.
    { method: 'GET', path: '/admin/credentials/kinds', handler: handlers.kinds },
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

export { ADMIN_BODY_MAX_BYTES } from './shared.js';
