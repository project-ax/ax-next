import type { Plugin, WorkspaceDelta } from '@ax/core';
import { makeAgentContext } from '@ax/core';
import type { Kysely } from 'kysely';
import { runRoutinesMigration, type RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import { handleWorkspaceApplied } from './sync.js';
import { systemClock, type Clock } from './clock.js';
import { runTickLoop } from './tick.js';
import { createFireRoutine, type PendingFires } from './fire.js';
import type { RoutinesConfig } from './types.js';

const PLUGIN_NAME = '@ax/routines';

export function createRoutinesPlugin(
  config: RoutinesConfig = {},
  clock: Clock = systemClock,
): Plugin {
  let db: Kysely<RoutinesDatabase> | undefined;
  let store: RoutinesStore | undefined;
  let abortCtl: AbortController | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['routines:fire-now', 'routines:list'],
      calls: [
        'database:get-instance',
        'agents:resolve',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
      ],
      subscribes: ['workspace:applied', 'chat:turn-end'],
    },
    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system',
      });
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance', initCtx, {},
      );
      db = shared as Kysely<RoutinesDatabase>;
      await runRoutinesMigration(db);
      store = createRoutinesStore(db);
      const localStore = store;
      const localDb = db;
      const pending: PendingFires = new Map();
      const fireRoutine = createFireRoutine({ bus, pending });

      bus.subscribe<WorkspaceDelta>(
        'workspace:applied', PLUGIN_NAME,
        async (ctx, delta) => {
          await handleWorkspaceApplied(localStore, ctx, delta, clock.now());
          return undefined;
        },
      );

      const tickIntervalMs = config.tickIntervalMs ?? 5_000;
      const tickConfig = {
        tickIntervalMs,
        claimBatchSize: config.claimBatchSize ?? 50,
        claimWindowMinutes: config.claimWindowMinutes ?? 5,
        electionRetryMs: config.electionRetryMs ?? tickIntervalMs * 10,
      };

      abortCtl = new AbortController();
      void runTickLoop({
        db: localDb, store: localStore, fire: fireRoutine, clock,
        signal: abortCtl.signal,
        ...tickConfig,
      }).catch((err) => {
        process.stderr.write(`[ax/routines] tick loop died: ${err}\n`);
      });
    },
    async shutdown() {
      abortCtl?.abort();
      abortCtl = undefined;
      db = undefined;
      store = undefined;
    },
  };
}
