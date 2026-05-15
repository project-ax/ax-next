import type { Plugin, WorkspaceDelta } from '@ax/core';
import { makeAgentContext, PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import { runRoutinesMigration, type RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import { handleWorkspaceApplied } from './sync.js';
import { systemClock, type Clock } from './clock.js';
import { runTickLoop } from './tick.js';
import { createFireRoutine, type PendingFires } from './fire.js';
import { applySilenceLogic } from './silence.js';
import type { RoutinesConfig, FireNowInput, FireNowOutput, ListInput, ListOutput } from './types.js';

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

      bus.subscribe<{
        reqId?: string;
        contentBlocks?: unknown[];
        turnId?: string;
      }>('chat:turn-end', PLUGIN_NAME, async (ctx, payload) => {
        const reqId = payload.reqId ?? ctx.reqId;
        if (typeof reqId !== 'string' || reqId.length === 0) return undefined;
        const pf = pending.get(reqId);
        if (pf === undefined) return undefined;
        pending.delete(reqId);
        try {
          const blocks = payload.contentBlocks ?? [];
          const decision = applySilenceLogic(blocks, {
            silenceToken: pf.row.silenceToken,
            silenceMaxChars: pf.row.silenceMaxChars,
          });
          if (decision.silenced) {
            // Only drop when we have an explicit turnId. An empty/missing
            // turnId would trigger the "drop most recent" path, which can
            // remove an unrelated turn if chat:turn-end fired without
            // surfacing the turnId (e.g., runner-side bug or non-routine
            // event piggy-backing on the same reqId).
            const turnId = payload.turnId;
            if (typeof turnId === 'string' && turnId.length > 0) {
              try {
                await bus.call('conversations:drop-turn', ctx, {
                  conversationId: pf.conversationId,
                  userId: pf.row.authorUserId,
                  turnId,
                });
              } catch (err) {
                ctx.logger.warn('routines_drop_turn_failed', {
                  conversationId: pf.conversationId,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            } else {
              ctx.logger.warn('routines_drop_turn_skipped_no_turn_id', {
                conversationId: pf.conversationId,
              });
            }
            if (pf.row.conversation === 'per-fire') {
              try {
                await bus.call('conversations:hide', ctx, {
                  conversationId: pf.conversationId,
                  userId: pf.row.authorUserId,
                });
              } catch (err) {
                ctx.logger.warn('routines_hide_failed', {
                  conversationId: pf.conversationId,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            }
            await localStore.recordFire({
              agentId: pf.row.agentId, path: pf.row.path,
              triggerSource: pf.source,
              conversationId: pf.conversationId,
              status: 'silenced', error: null,
            });
          } else {
            await localStore.recordFire({
              agentId: pf.row.agentId, path: pf.row.path,
              triggerSource: pf.source,
              conversationId: pf.conversationId,
              status: 'ok', error: null,
            });
          }
        } catch (err) {
          ctx.logger.warn('routines_turn_end_handler_failed', {
            reqId, err: err instanceof Error ? err.message : String(err),
          });
        }
        return undefined;
      });

      bus.registerService<ListInput, ListOutput>(
        'routines:list', PLUGIN_NAME,
        async (_ctx, input) => {
          const filter: { agentId?: string } = {};
          if (input.agentId !== undefined) filter.agentId = input.agentId;
          const routines = await localStore.list(filter);
          return { routines };
        },
      );

      bus.registerService<FireNowInput, FireNowOutput>(
        'routines:fire-now', PLUGIN_NAME,
        async (_ctx, input) => {
          const all = await localStore.list({ agentId: input.agentId });
          const row = all.find((r) => r.path === input.path);
          if (row === undefined) {
            throw new PluginError({
              code: 'not-found', plugin: PLUGIN_NAME,
              hookName: 'routines:fire-now',
              message: `routine ${input.agentId}/${input.path} not found`,
            });
          }
          const source = input.source ?? 'manual';
          const result = await fireRoutine(row, source === 'tick' ? 'tick' : 'manual');
          const fireId = await localStore.recordFire({
            agentId: row.agentId, path: row.path,
            triggerSource: source,
            conversationId: result.conversationId ?? null,
            status: result.status,
            error: result.error,
          });
          return {
            fireId,
            status: result.status,
            conversationId: result.conversationId ?? null,
          };
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
        db: localDb, fire: fireRoutine, clock,
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
