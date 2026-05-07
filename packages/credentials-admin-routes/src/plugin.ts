import { type Plugin } from '@ax/core';
import { registerAdminCredentialsRoutes } from './admin-routes.js';
import { registerSettingsCredentialsRoutes } from './settings-routes.js';
import { registerOauthRoutes } from './oauth-routes.js';
import { makeAgentContext } from '@ax/core';

const PLUGIN_NAME = '@ax/credentials-admin-routes';

// ---------------------------------------------------------------------------
// @ax/credentials-admin-routes
//
// Mounts two HTTP route trees on top of the credentials facade (Phase 1):
//
//   - /admin/credentials*    — admin-only CRUD over the full scope axis
//                              (global / user / agent). Used by the admin UI
//                              for shared keys + cross-user surgery.
//   - /settings/credentials* — per-user CRUD restricted to scope='user' and
//                              ownerId=actor.id. Used by the settings UI
//                              every authed user gets.
//
// Both trees mirror the @ax/agents admin-routes pattern: duck-typed
// req/res surface (no @ax/http-server import per Invariant I2), 64 KiB
// body cap, zod-validated payloads, and PluginError → HTTP-status mapping.
//
// OAuth start/finish routes ride alongside (Phase 3): they call into
// `credentials:oauth:stash-pending` / `:claim-pending` (the in-memory
// state holder in @ax/credentials-oauth-pending) and the per-kind
// `credentials:login:*` / `credentials:exchange:*` services.
// ---------------------------------------------------------------------------

export function createCredentialsAdminRoutesPlugin(): Plugin {
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      // Hard deps. http:register-route + auth:require-user come from
      // @ax/http-server + @ax/auth-oidc; credentials:* from @ax/credentials.
      // Topo-sort ensures all are loaded before our init runs.
      //
      // Per-kind `credentials:login:*` and `credentials:exchange:*` are
      // checked at runtime (bus.hasService) — declaring every kind here
      // would couple the plugin to a static list. The OAuth start handler
      // 400s when the kind isn't registered.
      calls: [
        'auth:require-user',
        'http:register-route',
        'credentials:list',
        'credentials:list-kinds',
        'credentials:set',
        'credentials:delete',
        'credentials:oauth:stash-pending',
        'credentials:oauth:claim-pending',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      unregisterRoutes.push(...(await registerAdminCredentialsRoutes(bus, initCtx)));
      unregisterRoutes.push(
        ...(await registerSettingsCredentialsRoutes(bus, initCtx)),
      );
      unregisterRoutes.push(...(await registerOauthRoutes(bus, initCtx)));
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
