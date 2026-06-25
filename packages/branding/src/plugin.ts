import { type Plugin, makeAgentContext } from '@ax/core';
import { registerBrandingRoutes } from './routes.js';

const PLUGIN_NAME = '@ax/branding';

// ---------------------------------------------------------------------------
// @ax/branding
//
// Owns the single "branding" concept: the product name + logo (light/dark).
// Mounts a PUBLIC read/serve surface (`GET /api/branding`, `GET
// /api/branding/logo/:variant`) and an ADMIN write surface (`PUT
// /admin/branding`). Persists a JSON pointer record via storage:* (key
// `settings:branding`) and the logo bytes via blob:*. Registers no new
// service hooks — it only mounts HTTP routes and calls existing kernel hooks.
// ---------------------------------------------------------------------------

export function createBrandingPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      // Hard deps. http:register-route ← @ax/http-server; auth:require-user ←
      // the auth plugin; storage:get/set ← a storage plugin; blob:put/get/
      // delete ← a blob store. The topo-sort in bootstrap() wires these before
      // init runs.
      calls: [
        'http:register-route',
        'auth:require-user',
        'storage:get',
        'storage:set',
        'blob:put',
        'blob:get',
        'blob:delete',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      try {
        unregisterRoutes.push(...(await registerBrandingRoutes(bus, initCtx)));
      } catch (err) {
        while (unregisterRoutes.length > 0) {
          const fn = unregisterRoutes.pop();
          try {
            fn?.();
          } catch (unwindErr) {
            console.warn(
              `[${PLUGIN_NAME}] failed to unregister route during init-unwind: ${
                unwindErr instanceof Error
                  ? unwindErr.message
                  : String(unwindErr)
              }`,
            );
          }
        }
        throw err;
      }
    },

    async shutdown() {
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch (err) {
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
