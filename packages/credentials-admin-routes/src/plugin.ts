import { type Plugin } from '@ax/core';
import { registerAdminCredentialsRoutes } from './admin-routes.js';
import { registerDestinationRoutes } from './destination-routes.js';
import {
  registerProviderRoutes,
  registerProviderService,
} from './providers-routes.js';
import { makeAgentContext } from '@ax/core';

const PLUGIN_NAME = '@ax/credentials-admin-routes';

// ---------------------------------------------------------------------------
// @ax/credentials-admin-routes
//
// Mounts HTTP route trees on top of the credentials facade:
//
//   - /admin/credentials*             — read-only GET routes (list + kinds).
//                                       Used by the new UI's status pill.
//   - /admin/credentials/providers*   — provider list + validate-and-save.
//
// Write surface for the new UX redesign (Task 19):
//
//   - /admin/destinations/:kind/credential   — admin write (creates/deletes
//                                              credentials by destination ref).
//   - /settings/destinations/:kind/credential— user-scoped write (scope and
//                                              ownerId are forced to the
//                                              authenticated user; body values
//                                              for those fields are ignored).
//
//   Both write trees are implemented in destination-routes.ts.
//
// The legacy /settings/credentials* CRUD routes and the /oauth/* routes
// were removed in the credentials UX redesign (Task 19).
// ---------------------------------------------------------------------------

export function createCredentialsAdminRoutesPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['credentials:list-providers'],
      // Hard deps. http:register-route + auth:require-user come from
      // @ax/http-server + @ax/auth-oidc; credentials:* from @ax/credentials.
      // Topo-sort ensures all are loaded before our init runs.
      //
      // `credentials:validate:*` is checked at runtime (bus.hasService)
      // — the providers validate endpoint falls back to built-in logic if
      // not registered.
      calls: [
        'auth:require-user',
        'http:register-route',
        'credentials:list',
        'credentials:list-kinds',
        // credentials:set + credentials:delete are called by destination-routes
        // and providers-routes (validate path). Listed here for manifest
        // completeness; the actual calls live in those files.
        'credentials:set',
        'credentials:delete',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      // Register the credentials:list-providers service first so the HTTP
      // handlers can call it via the bus.
      unregisterRoutes.push(registerProviderService(bus));
      // Atomic route registration: if any of the register* calls throws
      // after earlier ones succeeded, init() would otherwise leave
      // partially-mounted routes behind (and shutdown won't run because
      // bootstrap treats the plugin as failed). Unwind anything we already
      // pushed, best-effort, then rethrow.
      try {
        unregisterRoutes.push(
          ...(await registerAdminCredentialsRoutes(bus, initCtx)),
        );
        unregisterRoutes.push(
          ...(await registerProviderRoutes(bus, initCtx)),
        );
        unregisterRoutes.push(
          ...(await registerDestinationRoutes(bus, initCtx)),
        );
      } catch (err) {
        while (unregisterRoutes.length > 0) {
          const fn = unregisterRoutes.pop();
          try {
            fn?.();
          } catch {
            // best-effort unwind
          }
        }
        throw err;
      }
    },

    async shutdown() {
      // Drop routes first so a re-init doesn't trip duplicate-route on the
      // http-server. unregister is idempotent per http-server's contract;
      // we still wrap each in try/catch so a transport error doesn't abort
      // the rest of the shutdown.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
    },
  };
}
