import { makeAgentContext, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import type { BridgeBus } from './access.js';
import { answerCall, answerClaim, answerGrants, type BridgeDeps } from './bridge-call.js';
import { CLEANUP_HOOKS, CLEANUP_SUBSCRIBER_KEY, subscribeCleanup } from './cleanup.js';
import { assertAppsBridgeConfig, type AppsBridgeConfig } from './config.js';
import { createBridgeLimiter, type BridgeLimiter } from './limits.js';
import { startBridgeListener, type BridgeListener } from './listener.js';
import { runAppsBridgeMigration, type AppsBridgeDatabase } from './migrations.js';
import { registerSettingsRoutes, unwind } from './settings-routes.js';
import { createAppsBridgeStore } from './store.js';
import { createCallerVerifier, createViewerVerifier, type CallerVerdict } from './verify-token.js';

export const PLUGIN_NAME = '@ax/apps-bridge';

export interface AppsBridgePlugin extends Plugin {
  /** The bridge listener's port while it is bound; undefined when the bridge is off or not (yet, or any longer) listening. */
  bridgeBoundPort(): number | undefined;
}

/**
 * Lets an outside app call an agent's connectors through a link the agent's
 * owner made. It owns the tables and cleans them up when an agent or a
 * connector is deleted, and, with `config.bridge`, serves the platform on its
 * own listener (listener.ts): bound in `startAdmission()`, closed to new
 * connections in `stopAdmission()`, and closed for good in `shutdown()`.
 * Without `config.bridge` nothing listens.
 *
 * Either way it mounts the Apps settings and approve routes on the public
 * listener (settings-routes.ts) in `init()` and takes them down in
 * `shutdown()`. With the bridge off they say so (`{ enabled: false }`, or
 * 409 `bridge-off` on a write) and touch nothing.
 */
export function createAppsBridgePlugin(config: AppsBridgeConfig): AppsBridgePlugin {
  assertAppsBridgeConfig(config);
  const now = config.now ?? Date.now;
  // Approve links are built from the origin alone, so a trailing slash or a
  // path on AX_PUBLIC_BASE_URL can't double a slash.
  const publicOrigin = new URL(config.publicOrigin).origin;

  let unsubscribe: (() => void) | undefined;
  /** The settings routes' unregisters, newest last. */
  let routeUndos: Array<() => void> = [];
  /** Built in init() when the bridge is on; the listener is started from it. */
  let wired: { deps: BridgeDeps; verifyCaller: (token: string) => Promise<CallerVerdict>; limiter: BridgeLimiter } | undefined;
  let listener: BridgeListener | undefined;
  let stopped = false;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'database:get-instance',
        // The settings and approve routes (settings-routes.ts): the signed-in
        // person, and the viewer's own personal agents.
        'http:register-route',
        'auth:require-user',
        'agents:list-for-user',
        'auth:find-user-by-email',
        'agents:resolve',
        'agents:can-manage-connectors',
        'connectors:list',
        'connectors:list-effective',
        'connectors:describe-tools',
        'tool-policy:evaluate',
        'connectors:call-tool-result',
      ],
      subscribes: [...CLEANUP_HOOKS],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db } = await bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', initCtx, {});
      const typed = db as Kysely<AppsBridgeDatabase>;
      await runAppsBridgeMigration(typed);
      const store = createAppsBridgeStore(typed);
      subscribeCleanup(bus, store);
      unsubscribe = () => {
        for (const hook of CLEANUP_HOOKS) bus.unsubscribe(hook, CLEANUP_SUBSCRIBER_KEY);
      };

      const bridge = config.bridge;
      if (bridge !== undefined) {
        const limiter = createBridgeLimiter({ now });
        // A local structural view of the bus (no Bus type from @ax/core).
        const bridgeBus: BridgeBus = bus;
        // One limiter for the listener (takePlatform, acquire) and the
        // answers (takeApp), so every window is counted in one place.
        wired = {
          deps: {
            bus: bridgeBus,
            store,
            platformId: bridge.platformId,
            publicOrigin,
            verifyViewer: createViewerVerifier(bridge.viewer, { now }),
            limiter,
            logger: initCtx.logger,
            now,
          },
          verifyCaller: createCallerVerifier(bridge.caller, { now }),
          limiter,
        };
      }
      // Last, so nothing after it can fail with routes up (a failed
      // registration takes its own earlier routes down). Mounted with the
      // bridge off too: the Apps section then says it is off.
      routeUndos = await registerSettingsRoutes(bus, { store, platformId: bridge?.platformId, logger: initCtx.logger, now });
    },

    async startAdmission() {
      const bridge = config.bridge;
      if (bridge === undefined || wired === undefined || stopped || listener !== undefined) return;
      const d = wired.deps;
      listener = await startBridgeListener({
        host: bridge.host,
        port: bridge.port,
        platformId: bridge.platformId,
        verifyCaller: wired.verifyCaller,
        limiter: wired.limiter,
        claim: (body) => answerClaim(d, body),
        call: (body) => answerCall(d, body),
        grants: (appId) => answerGrants(d, appId),
        logger: d.logger,
      });
    },

    async stopAdmission() {
      stopped = true;
      await listener?.stopAccepting();
    },

    // Also runs without stopAdmission() first (a failed boot's rollback, a
    // test harness), so close() stops admission itself. Idempotent: the
    // listener's close() is.
    async shutdown() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      // Newest first; one that throws doesn't keep the rest up. Empties the list, so a second shutdown is a no-op.
      unwind(routeUndos);
      await listener?.close();
    },

    bridgeBoundPort() {
      return listener !== undefined && !stopped ? listener.port() : undefined;
    },
  };
}
