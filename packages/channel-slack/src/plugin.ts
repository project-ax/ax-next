import { randomBytes } from 'node:crypto';
import { PluginError, makeAgentContext, type HookBus, type Logger, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { createAdminRoutes } from './admin-routes.js';
import { EVENTS_ROUTE_PATH, createEventsHandler, createSeenEvents } from './events.js';
import type { RouteSpec } from './http-types.js';
import { createLifetime, type Lifetime } from './lifetime.js';
import {
  EVENT_DEDUPE_MAX,
  EVENT_DEDUPE_TTL_MS,
  EVENTS_MAX_BODY_BYTES,
  MAX_TURNS_PER_CONVERSATION,
  SIGNING_SECRET_CACHE_MAX,
  SIGNING_SECRET_CACHE_TTL_MS,
} from './limits.js';
import { logCode } from './log-code.js';
import { runMigrations, type ChannelSlackDatabase } from './migrations.js';
import { createMutex } from './mutex.js';
import { systemClock } from './reply-stream.js';
import { createEventRouter } from './router.js';
import { cacheSigningSecrets, type SigningSecretCache } from './secret-cache.js';
import { createSecretStore } from './secrets.js';
import { createSlackApi } from './slack-api.js';
import { createInstallStore, type InstallStore } from './store.js';
import { createKeyedQueue } from './turn-queue.js';
import { TURN_EVENT_HOOKS, createTurnRegistry, subscribeTurnEvents } from './turn-registry.js';

// ---------------------------------------------------------------------------
// @ax/channel-slack — connect a Slack workspace from AX admin settings, and
// (TASK-1093 PR B) let every AX user DM the shared bot to talk to their own
// personal agent. Design: docs/plans/2026-11-09-channel-slack-design.md.
//
// It registers no hooks. It mounts, through `http:register-route`:
//
//   GET  /admin/slack, POST /admin/slack/{connect,install-url,disconnect},
//   GET  /admin/slack/oauth/callback  — admin only, CSRF-checked (admin-routes.ts)
//   POST /slack/events/:installId     — Slack's deliveries: the ONE route that
//        bypasses CSRF, because its caller is Slack, authenticated by the
//        signature over the raw body and the install id in the path (events.ts)
//
// It keeps one install row in its own `channel_slack_v1_installs` table and
// the install's four secrets in the credentials vault. Its only egress is
// `https://slack.com/api/<method>`, through `fetchImpl` (slack-api.ts).
//
// A verified event goes to the router (router.ts): a 1:1 DM from an admitted
// member whose verified email maps to an AX user becomes a turn of their
// oldest personal agent, in the thread's conversation (origin 'slack'),
// queued behind any other turn in it (turn-queue.ts). The reply streams into
// the Slack thread (reply-stream.ts) from the turn's chat events, which one
// subscriber per event hands to the running turn (turn-registry.ts).
// ---------------------------------------------------------------------------

export const PLUGIN_NAME = '@ax/channel-slack';

export interface ChannelSlackConfig {
  /**
   * Where Slack reaches AX (the events URL and the OAuth redirect in the app
   * manifest) and where the admin is sent back to. http or https; only an
   * https origin can connect a workspace (Slack refuses plain http).
   */
  publicOrigin: string;
  /** A public image Slack fetches for the bot's avatar. Best-effort. */
  iconUrl?: string;
  /** Test seam. Default: the global fetch, looked up at call time. */
  fetchImpl?: typeof fetch;
  /** Epoch milliseconds. Test seam. */
  now?: () => number;
}

const RESET_CLEANUP = 'bootstrap:reset-cleanup';
const RESET_CLEANUP_KEY = `${PLUGIN_NAME}/bootstrap-reset-cleanup`;
/** The subscriber name for the three chat events DM turns read. */
export const TURN_EVENTS_KEY = `${PLUGIN_NAME}/dm-turns`;

const RESET_LEFT_APP_HINT =
  'The reset removed this install from AX, not from Slack. Delete the app at ' +
  'https://api.slack.com/apps and revoke its configuration token.';

function invalidConfig(message: string): PluginError {
  return new PluginError({ code: 'invalid-config', plugin: PLUGIN_NAME, message });
}

/** The origin as given, once it parses as an absolute http(s) URL. */
function checkPublicOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidConfig('publicOrigin must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidConfig('publicOrigin must use http or https');
  }
  return raw;
}

/** Run every undo, newest first. One that throws doesn't stop the rest. */
function unwind(undos: Array<() => void>): void {
  while (undos.length > 0) {
    const undo = undos.pop();
    try {
      undo?.();
    } catch {
      // A route that won't unregister is http-server's to report; keep going.
    }
  }
}

export function createChannelSlackPlugin(config: ChannelSlackConfig): Plugin {
  const publicOrigin = checkPublicOrigin(config.publicOrigin);
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = config.now ?? (() => Date.now());

  let lifetime: Lifetime | undefined;
  // Everything init registered, undone in reverse by shutdown (or by a failed init).
  const undos: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'http:register-route',
        'auth:require-user',
        'auth:get-user',
        'database:get-instance',
        'credentials:get',
        'credentials:set',
        'credentials:delete',
        'auth:find-user-by-email',
        'agents:list-for-user',
        'conversations:find-or-create',
        'agent:invoke',
      ],
      optionalCalls: [{ hook: 'branding:get', degradation: 'the default bot name is "ax"' }],
      subscribes: [RESET_CLEANUP, ...TURN_EVENT_HOOKS],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      const logger = initCtx.logger;

      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      const db = shared as Kysely<ChannelSlackDatabase>;
      await runMigrations(db);

      const store = createInstallStore(db);
      // One store for both the events route and the admin routes, so every
      // change the admin routes make to an install's secrets (a disconnect, a
      // failed connect's undo) drops the signing secret the events route keeps.
      const secrets = cacheSigningSecrets(createSecretStore(bus, { logger }), {
        ttlMs: SIGNING_SECRET_CACHE_TTL_MS,
        max: SIGNING_SECRET_CACHE_MAX,
        now,
      });
      const api = createSlackApi({ fetchImpl });
      const life = createLifetime();
      lifetime = life;
      const registry = createTurnRegistry();
      const queue = createKeyedQueue({ maxPerKey: MAX_TURNS_PER_CONVERSATION });

      const routes: RouteSpec[] = [
        ...createAdminRoutes({
          bus,
          store,
          secrets,
          api,
          lock: createMutex(),
          publicOrigin,
          ...(config.iconUrl !== undefined ? { iconUrl: config.iconUrl } : {}),
          logger,
          now,
          randomBytes,
        }),
        {
          method: 'POST',
          path: EVENTS_ROUTE_PATH,
          // Slack can't send our CSRF header. The route is authenticated by
          // the v0 signature over the raw body and the install id in the path.
          bypassCsrf: true,
          maxBodyBytes: EVENTS_MAX_BODY_BYTES,
          handler: createEventsHandler({
            store,
            secrets,
            lifetime: life,
            seen: createSeenEvents({ ttlMs: EVENT_DEDUPE_TTL_MS, max: EVENT_DEDUPE_MAX }),
            dispatch: createEventRouter({
              bus,
              api,
              registry,
              publicOrigin,
              logger,
              clock: systemClock,
              secrets,
              installs: store,
              queue,
            }),
            logger,
            now,
          }),
        },
      ];

      try {
        for (const route of routes) {
          const { unregister } = await bus.call<RouteSpec, { unregister(): void }>(
            'http:register-route',
            initCtx,
            route,
          );
          undos.push(unregister);
        }
        subscribeResetCleanup(bus, store, secrets, logger);
        undos.push(() => {
          bus.unsubscribe(RESET_CLEANUP, RESET_CLEANUP_KEY);
        });
        undos.push(subscribeTurnEvents(bus, registry, TURN_EVENTS_KEY));
        // Undone first: turns not yet started are dropped, and each install's
        // count is logged (those senders never get a reply). Running ones are
        // left to finish (or be cut short by the exit); nothing awaits them.
        undos.push(() => {
          for (const { group, count } of queue.close()) {
            try {
              logger.warn('slack_turns_dropped', { installId: group, reason: 'shutting-down', count });
            } catch {
              // A log line never stops the shutdown.
            }
          }
        });
      } catch (err) {
        unwind(undos);
        lifetime = undefined;
        throw err;
      }
    },

    stopAdmission() {
      lifetime?.stopAdmission();
    },

    async shutdown() {
      // No new deliveries first, then drain the dispatches already acked.
      lifetime?.stopAdmission();
      unwind(undos);
      await lifetime?.drain();
    },
  };
}

/**
 * `ax admin reset-bootstrap` wipes every credential, so an install row left
 * behind would read as "connected" with no secrets. Remove them all, logging
 * each deleted one's app id (the row was the only record of it, and the app
 * stays live in Slack). The lines come from the delete's own RETURNING, so
 * they name exactly what is gone: never a row a racing connect added between
 * a read and the delete, and nothing at all when the delete fails. A failure
 * is logged code-only and doesn't fail the reset (the bus never lets a
 * subscriber's throw do that either); re-running the reset retries it.
 *
 * The reset runs in the CLI's own process, which loads this plugin for that
 * reason, so the `clear()` below empties the CLI's signing-secret cache, not
 * the running host's. The host's copy of a wiped secret lasts at most
 * `SIGNING_SECRET_CACHE_TTL_MS` (60 s), and with the rows gone every event is
 * refused as an unknown install anyway, before any secret is read.
 */
function subscribeResetCleanup(
  bus: HookBus,
  store: InstallStore,
  secrets: SigningSecretCache,
  logger: Logger,
): void {
  bus.subscribe(RESET_CLEANUP, RESET_CLEANUP_KEY, async () => {
    secrets.clear();
    try {
      // The row is the only record of the Slack app's id, and the app stays
      // live in Slack after the delete. Say which ones, by id only (no
      // secret, no client id), so the operator can remove them.
      for (const install of await store.removeAll()) {
        logger.warn('slack_install_removed_by_reset', {
          installId: install.installId,
          appId: install.appId,
          teamId: install.teamId,
          hint: RESET_LEFT_APP_HINT,
        });
      }
    } catch (err) {
      try {
        logger.error('slack_reset_cleanup_failed', { code: logCode(err) });
      } catch {
        // Nothing left to report it with.
      }
    }
    return undefined;
  });
}
