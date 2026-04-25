import { createLogger, PluginError, type Logger, type Plugin } from '@ax/core';
import { Listener } from './listener.js';

/**
 * @ax/eventbus-postgres — LISTEN/NOTIFY-backed pub/sub.
 *
 * Same hook contract as @ax/eventbus-inprocess:
 *
 *   eventbus:emit(ctx, { channel, payload }) -> void
 *   eventbus:subscribe(ctx, { channel, handler }) -> { unsubscribe }
 *
 * Why we don't use @ax/database-postgres's pool: LISTEN binds to a
 * specific connection. If the pool returns the connection to its idle
 * set, the LISTEN binding is gone and notifications stop arriving. So
 * this plugin opens its OWN dedicated pg.Client and holds it forever
 * (with reconnect on error).
 *
 * Surface validation:
 *  - Channel names must match `/^[a-zA-Z0-9_]+$/`. Postgres NOTIFY needs
 *    a plain identifier; this allowlist is also a safety belt against
 *    untrusted callers passing arbitrary SQL even though we
 *    parameter-bind the channel value to pg_notify().
 *  - Payload JSON must be ≤ 8000 bytes. That's postgres's documented
 *    NOTIFY hard cap (`max_notify_queue_pages` × NAMEDATALEN math). Going
 *    over silently truncates or errors at the server, so we reject early
 *    with a structured PluginError.
 */

const PLUGIN_NAME = '@ax/eventbus-postgres';
const NOTIFY_MAX_BYTES = 8000;
const CHANNEL_RE = /^[a-zA-Z0-9_]+$/;

export interface EventbusPostgresConfig {
  connectionString: string;
  /**
   * Optional logger for background events that don't ride a request — pg.Client
   * 'error' events on the dedicated LISTEN connection (postgres restart, idle
   * socket close) and reconnect-attempt failures. Defaults to a stdout JSON
   * logger tagged `reqId=eventbus-postgres-bg`.
   */
  logger?: Logger;
}

export interface EventbusEmitInput {
  channel: string;
  payload: unknown;
}

export type EventbusHandler = (payload: unknown) => Promise<void>;

export interface EventbusSubscribeInput {
  channel: string;
  handler: EventbusHandler;
}

export interface EventbusSubscription {
  unsubscribe: () => void;
}

/**
 * Same shape as a Plugin, but with a `shutdown()` escape hatch tests use
 * to drain the dedicated LISTEN client before stopping the testcontainer.
 * Production callers should NOT depend on this — when the kernel gains a
 * shutdown lifecycle, it'll move there.
 */
export interface EventbusPostgresPlugin extends Plugin {
  shutdown(): Promise<void>;
}

export function createEventbusPostgresPlugin(
  config: EventbusPostgresConfig,
): EventbusPostgresPlugin {
  validateConnectionString(config.connectionString);

  // Local per-instance subscriber map. Keeps every subscriber of the same
  // process able to fire even though all of them share one pg connection.
  // Cross-instance delivery rides postgres NOTIFY.
  const localSubs = new Map<string, Set<EventbusHandler>>();

  let listener: Listener | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['eventbus:emit', 'eventbus:subscribe'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      const bgLogger =
        config.logger ?? createLogger({ reqId: 'eventbus-postgres-bg' });
      listener = new Listener({
        connectionString: config.connectionString,
        logger: bgLogger,
      });

      bus.registerService<EventbusEmitInput, void>(
        'eventbus:emit',
        PLUGIN_NAME,
        async (_ctx, { channel, payload }) => {
          assertChannel(channel);
          const json = JSON.stringify(payload);
          // Byte length, not char length — UTF-8 is what postgres counts.
          if (Buffer.byteLength(json, 'utf8') > NOTIFY_MAX_BYTES) {
            throw new PluginError({
              code: 'payload-too-large',
              plugin: PLUGIN_NAME,
              hookName: 'eventbus:emit',
              message: `eventbus:emit payload exceeds ${NOTIFY_MAX_BYTES}-byte postgres NOTIFY limit`,
            });
          }
          await listener!.notify(channel, json);
        },
      );

      bus.registerService<EventbusSubscribeInput, EventbusSubscription>(
        'eventbus:subscribe',
        PLUGIN_NAME,
        async (ctx, { channel, handler }) => {
          assertChannel(channel);
          if (typeof handler !== 'function') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'eventbus:subscribe',
              message: `eventbus:subscribe handler must be a function`,
            });
          }
          let set = localSubs.get(channel);
          if (set === undefined) {
            set = new Set();
            localSubs.set(channel, set);
          }
          set.add(handler);

          // The Listener calls our raw-json handler when ANY notification
          // for this channel arrives. We then fan out to local subscribers.
          // We register one raw handler per (channel, local handler) pair
          // so unsubscribe semantics line up cleanly.
          const removeFromListener = await listener!.addSubscriber(channel, (rawJson) => {
            let payload: unknown;
            try {
              payload = rawJson === '' ? undefined : JSON.parse(rawJson);
            } catch (err) {
              ctx.logger.error('eventbus_postgres_payload_parse_failed', {
                channel,
                err: err instanceof Error ? err : new Error(String(err)),
              });
              return;
            }
            // Each local handler is fired in its own try/catch so a
            // throwing subscriber doesn't take out its peers.
            void Promise.resolve(handler(payload)).catch((err) => {
              ctx.logger.error('eventbus_postgres_subscriber_failed', {
                channel,
                err: err instanceof Error ? err : new Error(String(err)),
              });
            });
          });

          return {
            unsubscribe: () => {
              const cur = localSubs.get(channel);
              if (cur === undefined) return;
              cur.delete(handler);
              if (cur.size === 0) localSubs.delete(channel);
              removeFromListener();
            },
          };
        },
      );
    },
    async shutdown() {
      localSubs.clear();
      if (listener !== undefined) {
        await listener.shutdown();
        listener = undefined;
      }
    },
  };
}

function assertChannel(channel: unknown): asserts channel is string {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    throw new PluginError({
      code: 'invalid-channel',
      plugin: PLUGIN_NAME,
      message: `eventbus channel must match /^[a-zA-Z0-9_]+$/, got: ${JSON.stringify(channel)}`,
    });
  }
}

function validateConnectionString(connectionString: unknown): void {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `${PLUGIN_NAME}: connectionString must be a non-empty string`,
    });
  }
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `${PLUGIN_NAME}: connectionString must start with postgres:// or postgresql://`,
    });
  }
}
