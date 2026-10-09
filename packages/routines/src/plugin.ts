import type { Plugin } from '@ax/core';
import { makeAgentContext } from '@ax/core';
import type { Kysely } from 'kysely';
import { runRoutinesMigration, type RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import { systemClock, type Clock } from './clock.js';
import { runTickLoop } from './tick.js';
import {
  createFireRoutine, stashConnectorsSkipped, warningFor, type PendingFires,
} from './fire.js';
import { applySilenceLogic } from './silence.js';
import type { RoutinesConfig } from './types.js';
import { registerRoutineServices, ROUTINE_SERVICES } from './services.js';
import { drainRoutineCleanup, purgeRoutineAgent } from './cleanup.js';

const PLUGIN_NAME = '@ax/routines';

export function createRoutinesPlugin(
  config: RoutinesConfig = {},
  clock: Clock = systemClock,
  runtime: Pick<Parameters<typeof registerRoutineServices>[0], 'dispatch'> = {},
): Plugin {
  let db: Kysely<RoutinesDatabase> | undefined;
  let store: RoutinesStore | undefined;
  let abortCtl: AbortController | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ROUTINE_SERVICES,
      calls: [
        'database:get-instance',
        'agents:resolve',
        'agents:can-manage-routines',
        'auth:get-user',
        'credentials:set',
        'credentials:delete',
        'agents:ensure-webhook-token',
        'agents:resolve-by-webhook-token',
        'agents:list-personal-owners',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
        'credentials:get',
        'http:register-route',
      ],
      subscribes: [
        'chat:turn-end',
        // Slice 6 — what a routine fire's turn went without (keyed by reqId).
        'chat:connectors-skipped',
        'agents:deleted',
      ],
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
      const fireRoutine = createFireRoutine({
        bus, pending,
        recordFire: (input) => localStore.recordFire(input),
      });

      // TASK-680 — a deleted agent's routines must stop with it. @ax/agents
      // fires this AFTER the agent row is gone; payload is `{ agentId,
      // ownerId, ownerType }` and only `agentId` is needed here. Rows orphaned
      // before this subscriber existed are healed by the tick instead (see
      // `agentGone` in tick.ts).
      bus.subscribe<{ agentId: string }>(
        'agents:deleted', PLUGIN_NAME,
        async (ctx, payload) => {
          try {
            await purgeRoutineAgent({ store: localStore, bus, pending, agentId: payload.agentId });
          } catch (err) {
            // K10: subscriber must not propagate — log and swallow. The tick's
            // `agentGone` path removes the rows on the agent's next due fire.
            ctx.logger.warn('routines_remove_for_deleted_agent_failed', {
              agentId: payload.agentId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          return undefined;
        },
      );

      // Slice 6 — chat-orchestrator fires this (awaited, bounded) before the
      // turn runs, for every turn that went without a connector. A routine
      // fire's turn carries its fire's reqId, so the skips land on the
      // pending entry before chat:turn-end takes it. Chat turns' reqIds are
      // not in `pending` and are ignored. A map write only — it must stay
      // fast, because the turn waits on it. Mirrors the orchestrator's
      // `ConnectorsSkippedPayload`; validated inside, never trusted.
      bus.subscribe<unknown>(
        'chat:connectors-skipped', PLUGIN_NAME,
        async (ctx, payload) => {
          try {
            stashConnectorsSkipped(pending, payload, ctx.logger);
          } catch (err) {
            ctx.logger.warn('routines_connectors_skipped_failed', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
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
        // Slice 6 — recorded on the fire row and as the routine's
        // last_warning; null clears the previous run's.
        const warning = warningFor(pf);
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
                  userId: pf.row.ownerUserId,
                  turnId,
                });
              } catch (err) {
                ctx.logger.warn('routines_drop_turn_failed', {
                  conversationId: pf.conversationId,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            } else {
              // Post-routines-followups Phase 2: chat:turn-end carries
              // turnId from runners. A missing turnId now indicates
              // either an older runner version or a runner-side bug —
              // log loud, skip safe.
              ctx.logger.warn('routines_drop_turn_skipped_no_turn_id', {
                conversationId: pf.conversationId,
              });
            }
            if (pf.row.conversation === 'per-fire') {
              try {
                await bus.call('conversations:hide', ctx, {
                  conversationId: pf.conversationId,
                  userId: pf.row.ownerUserId,
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
              renderedPrompt: pf.renderedPrompt,
              warning,
            });
          } else {
            await localStore.recordFire({
              agentId: pf.row.agentId, path: pf.row.path,
              triggerSource: pf.source,
              conversationId: pf.conversationId,
              status: 'ok', error: null,
              renderedPrompt: pf.renderedPrompt,
              warning,
            });
          }
        } catch (err) {
          ctx.logger.warn('routines_turn_end_handler_failed', {
            reqId, err: err instanceof Error ? err.message : String(err),
          });
        }
        return undefined;
      });

      registerRoutineServices({ bus, store: localStore, now: () => clock.now(), ...runtime });
      await drainRoutineCleanup({ bus, store: localStore });

      // Static DB webhook routing and durable dispatch wiring land in Task 8.
      // Do not start the retired file router against the new definition store.

      const tickIntervalMs = config.tickIntervalMs ?? 5_000;
      const tickConfig = {
        tickIntervalMs,
        claimBatchSize: config.claimBatchSize ?? 50,
        claimWindowMinutes: config.claimWindowMinutes ?? 5,
        electionRetryMs: config.electionRetryMs ?? tickIntervalMs * 10,
      };

      // Adapt agents:list-personal-owners → getAgents callback so
      // tick.ts stays free of HookBus imports. The owner id is what
      // fire.ts passes to agents:resolve's ACL gate, and the tick now
      // uses this list for TWO things: stamping newly materialized
      // default rows, and (TASK-397) re-asserting the owner on EVERY
      // routine of a user-owned agent via store.reconcileOwners — so
      // this callback is also what makes routine ownership follow the
      // agent instead of the last person to edit the file.
      // Failures inside the bus call
      // surface as a thrown promise inside runTickOnce, where the
      // I-R10 try/catch logs and continues (workspace claims still
      // fire).
      const getAgents = async (): Promise<Array<{ agentId: string; ownerUserId: string }>> => {
        const r = await bus.call<
          Record<string, never>,
          { agents: Array<{ agentId: string; ownerUserId: string }> }
        >('agents:list-personal-owners', initCtx, {});
        return r.agents;
      };

      abortCtl = new AbortController();
      void runTickLoop({
        db: localDb, fire: fireRoutine, getAgents, clock,
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
