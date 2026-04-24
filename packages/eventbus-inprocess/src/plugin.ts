import { PluginError, type Plugin } from '@ax/core';

/**
 * @ax/eventbus-inprocess — in-process, same-node eventbus.
 *
 * Contract (matched by the future @ax/eventbus-postgres impl):
 *
 *   eventbus:emit(ctx, { channel: string, payload: unknown }) -> void
 *   eventbus:subscribe(ctx, {
 *     channel: string,
 *     handler: (payload) => Promise<void>,
 *   }) -> { unsubscribe: () => void }
 *
 * Rules:
 * - Channel names must match `^[a-z0-9:_-]+$`. Anything else throws PluginError.
 * - Payloads must round-trip through JSON.stringify. We enforce this up front so
 *   the postgres-backed peer (which only accepts JSON-safe payloads) doesn't
 *   silently diverge from the in-process one.
 * - Subscribers on a channel fire in registration order. emit() awaits
 *   Promise.allSettled so one slow/failing subscriber can't block the others.
 * - If a subscriber throws, we log `eventbus_subscriber_failed` at error level
 *   via ctx.logger and continue delivering to the rest. Never console.log.
 */

const PLUGIN_NAME = '@ax/eventbus-inprocess';
const CHANNEL_RE = /^[a-z0-9:_-]+$/;

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

interface ChannelEntry {
  token: symbol;
  handler: EventbusHandler;
}

export function createEventbusInprocessPlugin(): Plugin {
  const channels = new Map<string, ChannelEntry[]>();

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['eventbus:emit', 'eventbus:subscribe'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<EventbusEmitInput, void>(
        'eventbus:emit',
        PLUGIN_NAME,
        async (ctx, { channel, payload }) => {
          assertChannel(channel);
          assertJsonSafe(payload);
          const entries = channels.get(channel);
          if (entries === undefined || entries.length === 0) return;
          // Snapshot so subscribers that unsubscribe during delivery don't
          // reshape the iteration mid-flight.
          const snapshot = entries.slice();
          const results = await Promise.allSettled(
            snapshot.map((e) => e.handler(payload)),
          );
          for (const r of results) {
            if (r.status !== 'rejected') continue;
            const reason: unknown = r.reason;
            ctx.logger.error('eventbus_subscriber_failed', {
              channel,
              err: reason instanceof Error ? reason : new Error(String(reason)),
            });
          }
        },
      );

      bus.registerService<EventbusSubscribeInput, EventbusSubscription>(
        'eventbus:subscribe',
        PLUGIN_NAME,
        async (_ctx, { channel, handler }) => {
          assertChannel(channel);
          if (typeof handler !== 'function') {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'eventbus:subscribe',
              message: `eventbus:subscribe handler must be a function`,
            });
          }
          const entry: ChannelEntry = { token: Symbol('eventbus-sub'), handler };
          const list = channels.get(channel) ?? [];
          list.push(entry);
          channels.set(channel, list);
          return {
            unsubscribe: () => {
              const current = channels.get(channel);
              if (current === undefined) return;
              const idx = current.findIndex((e) => e.token === entry.token);
              if (idx === -1) return;
              current.splice(idx, 1);
              if (current.length === 0) channels.delete(channel);
            },
          };
        },
      );
    },
  };
}

function assertChannel(channel: unknown): asserts channel is string {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `invalid channel name ${JSON.stringify(channel)}; must match ${CHANNEL_RE.source}`,
    });
  }
}

function assertJsonSafe(payload: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch (err) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `eventbus payload is not JSON-serializable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      cause: err,
    });
  }
  if (encoded === undefined) {
    // JSON.stringify returns undefined for bare functions, symbols, etc.
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `eventbus payload is not JSON-serializable (JSON.stringify returned undefined)`,
    });
  }
}
