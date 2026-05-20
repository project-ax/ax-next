import { type Plugin, makeAgentContext } from '@ax/core';
import {
  registerAdminDefaultRoutinesRoutes,
  registerRoutinesAdminRoutes,
} from './routes.js';

const PLUGIN_NAME = '@ax/routines-admin-routes';

// ---------------------------------------------------------------------------
// @ax/routines-admin-routes
//
// Mounts two surfaces on top of the routines facade (@ax/routines):
//
//   - /settings/routines*           — owner-scoped (per-user view of the
//                                     routines visible on agents they own)
//   - /admin/routines/defaults*     — admin-only CRUD over the default
//                                     routines library that materializes
//                                     per-agent on tick
//
// Both share the duck-typed req/res surface (no @ax/http-server import per
// Invariant I2) and the auth helpers in ./shared.ts (copied from
// credentials-admin-routes per Invariant L2 — no cross-plugin imports).
// ---------------------------------------------------------------------------

export function createRoutinesAdminRoutesPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      // Hard deps. http:register-route comes from @ax/http-server,
      // auth:require-user from @ax/auth-better, routines:* from @ax/routines,
      // and agents:resolve from @ax/agents. The topo-sort in bootstrap()
      // ensures these are wired before our init runs.
      //
      // The default-routines surface adds routines:*-default hooks; we don't
      // need a separate auth:require-admin call because requireAdmin is just
      // requireAuthenticated + an isAdmin check on the returned actor.
      calls: [
        'http:register-route',
        'auth:require-user',
        'routines:list',
        'routines:recent-fires',
        'routines:fire-now',
        'routines:list-defaults',
        'routines:get-default',
        'routines:upsert-default',
        'routines:delete-default',
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
      // Atomic route registration: each register* helper already unwinds
      // internally on partial failure, but we still push into our
      // shutdown-bound list AFTER each returns successfully so a re-init
      // doesn't double-mount. If the SECOND register call throws, we unwind
      // the FIRST batch in the catch below.
      try {
        unregisterRoutes.push(
          ...(await registerRoutinesAdminRoutes(bus, initCtx)),
        );
        unregisterRoutes.push(
          ...(await registerAdminDefaultRoutinesRoutes(bus, initCtx)),
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
