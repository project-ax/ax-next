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
 * - Subscribers on a channel fire in registration order. emit() awaits each
 *   handler before invoking the next so side-effects remain ordered.
 * - If a subscriber throws, we log `eventbus_subscriber_failed` at error
 *   level via ctx.logger and continue delivering to the rest. Never
 *   console.log.
 *
 * Out of scope here (belongs in the postgres peer where the wire format
 * demands it): channel-name sanitization, JSON-safety pre-checks, payload
 * size limits. The in-process impl trivially delivers any payload the
 * in-memory Map will hold, including Date/Map/Set/BigInt/function.
 */

const PLUGIN_NAME = '@ax/eventbus-inprocess';

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
          const entries = channels.get(channel);
          if (entries === undefined || entries.length === 0) return;
          // Snapshot so subscribers that unsubscribe during delivery don't
          // reshape the iteration mid-flight.
          const snapshot = entries.slice();
          for (const e of snapshot) {
            try {
              await e.handler(payload);
            } catch (err) {
              ctx.logger.error('eventbus_subscriber_failed', {
                channel,
                err: err instanceof Error ? err : new Error(String(err)),
              });
            }
          }
        },
      );

      bus.registerService<EventbusSubscribeInput, EventbusSubscription>(
        'eventbus:subscribe',
        PLUGIN_NAME,
        async (_ctx, { channel, handler }) => {
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
