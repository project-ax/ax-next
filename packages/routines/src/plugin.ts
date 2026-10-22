import type { Plugin } from '@ax/core';
import {
  makeAgentContext, MEMORY_PRE_CAPTURE_HOOK, SYSTEM_PROMPT_LANDED_HOOK, SystemPromptAugmentOutputSchema,
} from '@ax/core';
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

import { createRoutineLifetime, type RoutineLifetime } from './lifetime.js';
import { createWebhookRouter } from './webhook-handler.js';
import { registerRoutineTools, ROUTINE_TOOL_HOOKS } from './tools.js';
import {
  BRIEF_UNCONFIRMED, briefLandedVeto, checkInBrief, isTaskRun, refuseCheckIn, ROUTINES_AUGMENT_PROVIDER,
} from './brief.js';
import { taskCaptureVeto } from './capture.js';

const PLUGIN_NAME = '@ax/routines';

export function createRoutinesPlugin(
  config: RoutinesConfig = {},
  clock: Clock = systemClock,
  runtime: Pick<Parameters<typeof registerRoutineServices>[0], 'dispatch'> = {},
): Plugin {
  let db: Kysely<RoutinesDatabase> | undefined;
  let store: RoutinesStore | undefined;
  let unregisterWebhook: (() => void) | undefined;
  let lifetime: RoutineLifetime | undefined;
  let tickLoop: Promise<void> | undefined;
  let abortCtl: AbortController | undefined;

  return {
    shutdownMode: 'joined',
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // TASK-908: a task check-in's brief, in W1's `brief` section.
      registers: [...ROUTINE_SERVICES, ...ROUTINE_TOOL_HOOKS, ROUTINES_AUGMENT_PROVIDER],
      calls: [
        'database:get-instance',
        'tool:register',
        'decisions:authorize-routine-call',
        'decisions:settle-routine-call',
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
        'tool:pre-call',
        'chat:turn-end',
        // Slice 6 — what a routine fire's turn went without (keyed by reqId).
        'chat:connectors-skipped',
        // TASK-908 — whose system-prompt contributions landed; a task
        // check-in whose brief isn't listed is refused (keyed by reqId).
        SYSTEM_PROMPT_LANDED_HOOK,
        // TASK-908 — memory asks before it learns from a conversation; a task
        // check-in's is refused.
        MEMORY_PRE_CAPTURE_HOOK,
        'agents:deleted',
      ],
    },
    async init({ bus }) {
      // TASK-908 — memory doesn't learn from a task check-in (decisions rows
      // 14 and 22). Subscribed first, before the database is ready, so a
      // capture pass that arrives while this plugin is still starting (a
      // runner reporting into a freshly restarted host, say) is answered
      // rather than missed. Until the store is ready the lookup waits, inside
      // the veto's own deadline, so a slow start refuses instead of letting
      // the pass through. Answered from routines' own dispatch rows, not the
      // in-flight record, so a pass after the run finished, or after a
      // restart, is refused too.
      let storeReady!: (ready: RoutinesStore) => void;
      const ready = new Promise<RoutinesStore>(resolve => { storeReady = resolve; });
      bus.subscribe<unknown>(
        MEMORY_PRE_CAPTURE_HOOK, PLUGIN_NAME,
        (ctx, payload) => taskCaptureVeto({ isTaskConversation: async input => (await ready).isTaskConversation(input) }, ctx, payload),
      );

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
      // The capture check needs only the migrated schema: bound conversations
      // survive the abandoned-run pass below, so it needn't wait for that.
      storeReady(localStore);
      const localDb = db;
      await localStore.interruptAbandonedDispatches();
      lifetime = createRoutineLifetime();
      const effects = lifetime;
      const pending: PendingFires = new Map();
      const fireRoutine = createFireRoutine({
        bus, pending, lifetime: effects,
        store: localStore,
        purgeAgent: agentId => purgeRoutineAgent({ store: localStore, bus, pending, agentId }),
      });

      // TASK-680 — a deleted agent's routines must stop with it. @ax/agents
      // fires this AFTER the agent row is gone; payload is `{ agentId,
      // ownerId, ownerType }` and only `agentId` is needed here. Rows orphaned
      // before this subscriber existed are healed by the tick instead (see
      // `agentGone` in tick.ts).
      bus.subscribe<{ agentId: string }>(
        'agents:deleted', PLUGIN_NAME,
        (ctx, payload) => effects.track(async () => {
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
        }),
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

      // TASK-908 — a task check-in's brief. The orchestrator calls this with
      // the routine invoke's own ctx, so the answer comes from the fire this
      // plugin started under that reqId: no query on the spawn path, and the
      // brief, the message, the veto and the belt read one record.
      bus.registerService(
        ROUTINES_AUGMENT_PROVIDER, PLUGIN_NAME,
        async ctx => checkInBrief(pending, ctx),
        { returns: SystemPromptAugmentOutputSchema },
      );

      // TASK-908 — no brief, no check-in. The orchestrator fires this (awaited,
      // bounded) on every fresh spawn, after building the system prompt and
      // before any session opens. A pending task check-in whose brief isn't
      // listed is refused, and the turn ends `system-prompt:<reason>`. A map
      // read and write only. Fails closed: if working it out throws, a pending
      // task run is refused anyway.
      bus.subscribe<unknown>(
        SYSTEM_PROMPT_LANDED_HOOK, PLUGIN_NAME,
        async (ctx, payload) => {
          try {
            return briefLandedVeto(pending, ctx, payload);
          } catch {
            const entry = pending.get(ctx.reqId);
            const refusal = entry !== undefined && isTaskRun(entry.row) ? refuseCheckIn(entry, ctx) : undefined;
            try { ctx.logger.warn('routines_system_prompt_landed_failed', { agentId: ctx.agentId }); } catch { /* the answer stands */ }
            return refusal;
          }
        },
      );

      bus.subscribe<{
        reqId?: string;
        contentBlocks?: unknown[];
        turnId?: string;
      }>('chat:turn-end', PLUGIN_NAME, (ctx, payload) => effects.track(async () => {
        const reqId = payload.reqId ?? ctx.reqId;
        if (typeof reqId !== 'string' || reqId.length === 0) return undefined;
        const pf = pending.get(reqId);
        if (pf === undefined) return undefined;
        pending.delete(reqId);
        // Slice 6 — recorded on the fire row and as the routine's
        // last_warning; null clears the previous run's.
        const warning = warningFor(pf);
        // TASK-908 — the belt: a task check-in whose brief was never confirmed
        // landed (the event timed out, threw, or a spawn path never fired it)
        // is recorded as failed, whatever its turn said. Its report, if it
        // sent one, stays on the row.
        if (isTaskRun(pf.row) && pf.brief !== 'landed') {
          try {
            ctx.logger.warn('routines_check_in_brief_unconfirmed', {
              agentId: pf.row.agentId, routineId: pf.row.routineId, dispatchId: pf.dispatchId,
            });
          } catch { /* the run is still recorded below */ }
          try {
            await localStore.finishDispatch({ dispatchId: pf.dispatchId, outcome: {
              conversationId: pf.conversationId,
              status: 'error', error: BRIEF_UNCONFIRMED,
              renderedPrompt: pf.renderedPrompt,
              warning,
            } });
          } catch (err) {
            ctx.logger.warn('routines_turn_end_handler_failed', {
              reqId, err: err instanceof Error ? err.message : String(err),
            });
          }
          return undefined;
        }
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
                await bus.callJoined('conversations:drop-turn', ctx, {
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
                await bus.callJoined('conversations:hide', ctx, {
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
            await localStore.finishDispatch({ dispatchId: pf.dispatchId, outcome: {
              conversationId: pf.conversationId,
              status: 'silenced', error: null,
              renderedPrompt: pf.renderedPrompt,
              warning,
            } });
          } else {
            await localStore.finishDispatch({ dispatchId: pf.dispatchId, outcome: {
              conversationId: pf.conversationId,
              status: 'ok', error: null,
              renderedPrompt: pf.renderedPrompt,
              warning,
            } });
          }
        } catch (err) {
          ctx.logger.warn('routines_turn_end_handler_failed', {
            reqId, err: err instanceof Error ? err.message : String(err),
          });
        }
        return undefined;
      }));

      registerRoutineServices({ bus, store: localStore, now: () => clock.now(), admitDispatch: effects.admit, dispatch: async accepted => { const result = await fireRoutine(accepted); return { status: result.status === 'error' ? 'error' : 'ok' }; }, ...runtime });
      await registerRoutineTools({ bus, store: localStore, now: () => clock.now() });
      await drainRoutineCleanup({ bus, store: localStore });

      const handler = createWebhookRouter({ bus, store: localStore, fire: fireRoutine, now: () => clock.now() });
      const route = await bus.call<unknown, { unregister(): void }>('http:register-route', initCtx, {
        method: 'POST', path: '/webhooks/:token/*', bypassCsrf: true,
        handler: (req: Parameters<typeof handler>[0], res: Parameters<typeof handler>[1]) => effects.admit(() => handler(req, res)),
      });
      unregisterWebhook = route.unregister;

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
        const r = await bus.callJoined<
          Record<string, never>,
          { agents: Array<{ agentId: string; ownerUserId: string }> }
        >('agents:list-personal-owners', initCtx, {});
        return r.agents;
      };

      abortCtl = new AbortController();
      tickLoop = runTickLoop({
        db: localDb, fire: fireRoutine, getAgents, clock,
        cleanup: () => drainRoutineCleanup({ bus, store: localStore }),
        signal: abortCtl.signal,
        ...tickConfig,
      }).catch((err) => {
        process.stderr.write(`[ax/routines] tick loop died: ${err}\n`);
      });
    },
    async shutdown() {
      lifetime?.stopAdmission();
      unregisterWebhook?.();
      unregisterWebhook = undefined;
      abortCtl?.abort();
      await tickLoop;
      await lifetime?.drain();
      tickLoop = undefined;
      abortCtl = undefined;
      db = undefined;
      store = undefined;
    },
  };
}
