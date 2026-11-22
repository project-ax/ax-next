import { makeAgentContext, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { CLEANUP_HOOKS, CLEANUP_SUBSCRIBER_KEY, subscribeCleanup } from './cleanup.js';
import type { AppsBridgeConfig } from './config.js';
import { runAppsBridgeMigration, type AppsBridgeDatabase } from './migrations.js';
import { createAppsBridgeStore } from './store.js';

export const PLUGIN_NAME = '@ax/apps-bridge';

/**
 * Lets an outside app call an agent's connectors through a link the agent's
 * owner made. This is the skeleton: it owns the tables and cleans them up
 * when an agent or a connector is deleted. The listener, the claim, call and
 * grants logic and the settings routes land on top of it (Tasks 7-9), and
 * `calls` grows with them.
 */
export function createAppsBridgePlugin(config: AppsBridgeConfig): Plugin {
  // Task 8 validates and uses the config; the skeleton only carries it.
  void config;
  let unsubscribe: (() => void) | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['database:get-instance'],
      subscribes: [...CLEANUP_HOOKS],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db } = await bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', initCtx, {});
      const typed = db as Kysely<AppsBridgeDatabase>;
      await runAppsBridgeMigration(typed);
      subscribeCleanup(bus, createAppsBridgeStore(typed));
      unsubscribe = () => {
        for (const hook of CLEANUP_HOOKS) bus.unsubscribe(hook, CLEANUP_SUBSCRIBER_KEY);
      };
    },

    async shutdown() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
