import { type Plugin, makeAgentContext } from '@ax/core';
import { registerRoutinesAdminRoutes } from './routes.js';

const PLUGIN_NAME = '@ax/routines-admin-routes';

// ---------------------------------------------------------------------------
// @ax/routines-admin-routes
//
// Mounts /settings/routines* on top of the routines facade (@ax/routines).
// Owner-scoped only — /admin/routines* is intentionally not part of this
// package; the Routines admin UI is a per-user surface, not a fleet-wide
// shared-key surface like /admin/credentials.
//
// Duck-typed req/res surface (no @ax/http-server import per Invariant I2).
// No cross-plugin imports per Invariant L2 — `shared.ts` is copied from
// credentials-admin-routes, not imported.
// ---------------------------------------------------------------------------

export function createRoutinesAdminRoutesPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      // Hard deps. http:register-route comes from @ax/http-server,
      // auth:require-user from @ax/auth-oidc, routines:* from @ax/routines,
      // and agents:resolve from @ax/agents. The topo-sort in bootstrap()
      // ensures these are wired before our init runs.
      calls: [
        'http:register-route',
        'auth:require-user',
        'routines:list',
        'routines:recent-fires',
        'routines:fire-now',
        'agents:resolve',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      // Atomic route registration: registerRoutinesAdminRoutes already
      // unwinds internally on partial failure, but we still push into our
      // shutdown-bound list AFTER it returns successfully so a re-init
      // doesn't double-mount.
      try {
        unregisterRoutes.push(
          ...(await registerRoutinesAdminRoutes(bus, initCtx)),
        );
      } catch (err) {
        while (unregisterRoutes.length > 0) {
          const fn = unregisterRoutes.pop();
          try {
            fn?.();
          } catch (unwindErr) {
            // best-effort unwind — log so a transport error in the
            // unwinder doesn't silently leave a dangling route handler
            // behind. console.warn (not ctx.logger): we have no logger
            // available here without a service-call, and the parent
            // failure is what the operator chases first.
            console.warn(
              `[${PLUGIN_NAME}] failed to unregister route during init-unwind: ${
                unwindErr instanceof Error ? unwindErr.message : String(unwindErr)
              }`,
            );
          }
        }
        throw err;
      }
    },

    async shutdown() {
      // Drop routes first so a re-init doesn't trip duplicate-route on the
      // http-server. unregister is idempotent per http-server's contract;
      // we still wrap each call so a transport error doesn't abort the
      // rest of the shutdown sweep.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch (err) {
          // best-effort — log so a transport-side failure during shutdown
          // is visible. The next teardown attempt will still proceed.
          console.warn(
            `[${PLUGIN_NAME}] failed to unregister route during shutdown: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
  };
}
