import { type Plugin, makeAgentContext } from '@ax/core';
import { registerAdminSettingsRoutes } from './routes.js';

const PLUGIN_NAME = '@ax/admin-settings-routes';

// ---------------------------------------------------------------------------
// @ax/admin-settings-routes
//
// Mounts `/admin/settings/:key` (GET + PUT) on top of the kernel `storage:*`
// surface for the small set of allowlisted admin-managed settings (today:
// `fast-model`). Consumers read the same storage keys directly via
// `storage:get` — see @ax/conversation-titles for the canonical reader.
// ---------------------------------------------------------------------------

export function createAdminSettingsRoutesPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      // Hard deps. http:register-route comes from @ax/http-server,
      // auth:require-user from the auth plugin, storage:get / storage:set
      // from a storage plugin. The topo-sort in bootstrap() ensures these
      // are wired before init runs.
      calls: [
        'http:register-route',
        'auth:require-user',
        'storage:get',
        'storage:set',
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
        unregisterRoutes.push(
          ...(await registerAdminSettingsRoutes(bus, initCtx)),
        );
      } catch (err) {
        while (unregisterRoutes.length > 0) {
          const fn = unregisterRoutes.pop();
          try {
            fn?.();
          } catch (unwindErr) {
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
