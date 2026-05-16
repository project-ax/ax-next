import type { Plugin, WorkspaceDelta } from '@ax/core';
import { makeAgentContext, PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import { runRoutinesMigration, type RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import { handleWorkspaceApplied, mountAllWebhookRoutesOnStartup, rebindWebhooksForAgent } from './sync.js';
import { systemClock, type Clock } from './clock.js';
import { runTickLoop } from './tick.js';
import { createFireRoutine, type PendingFires } from './fire.js';
import { applySilenceLogic } from './silence.js';
import type { RoutinesConfig, FireNowInput, FireNowOutput, ListInput, ListOutput } from './types.js';

const PLUGIN_NAME = '@ax/routines';

/**
 * Single-replica only at v1: `workspace:applied` is a local in-process
 * hook (no LISTEN/NOTIFY broadcast), so webhook route registrations
 * are local to the replica that received the apply. Multi-replica
 * fan-out lands when the rest of the preset lifts out of
 * single-replica (presets/k8s/src/index.ts:51,650-723 — multiple
 * plugins already declare this). See K3 in
 * docs/plans/2026-05-15-routines-phase-c-design.md.
 */
export function createRoutinesPlugin(
  config: RoutinesConfig = {},
  clock: Clock = systemClock,
): Plugin {
  let db: Kysely<RoutinesDatabase> | undefined;
  let store: RoutinesStore | undefined;
  let abortCtl: AbortController | undefined;
  const webhookRoutes = new Map<string, () => void>();

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['routines:fire-now', 'routines:list'],
      calls: [
        'database:get-instance',
        'agents:resolve',
        'agents:ensure-webhook-token',
        'agents:resolve-by-webhook-token',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
        'credentials:get',
        'http:register-route',
      ],
      subscribes: ['workspace:applied', 'chat:turn-end', 'agents:webhook-token-rotated'],
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
          await handleWorkspaceApplied(
            { store: localStore, bus, webhookRoutes, fireRoutine },
            ctx, delta, clock.now(),
          );
          return undefined;
        },
      );

      bus.subscribe<{ agentId: string }>(
        'agents:webhook-token-rotated', PLUGIN_NAME,
        async (ctx, payload) => {
          try {
            await rebindWebhooksForAgent(
              { store: localStore, bus, webhookRoutes, fireRoutine },
              ctx, payload.agentId,
            );
          } catch (err) {
            // K10: subscriber must not propagate — log and swallow.
            ctx.logger.warn('routines_rebind_after_rotation_failed', {
              agentId: payload.agentId,
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

      // Re-mount webhook routes from DB before opening for traffic. After a
      // host pod restart the in-memory `webhookRoutes` Map is empty, but
      // `routines_v1_definitions` is not — without this, webhook URLs 403
      // until something else nudges `workspace:applied`. Per-row failures
      // are caught + logged inside the helper (K10).
      await mountAllWebhookRoutesOnStartup(
        { store: localStore, bus, webhookRoutes, fireRoutine },
        initCtx,
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
      for (const unreg of webhookRoutes.values()) {
        try { unreg(); } catch { /* idempotent */ }
      }
      webhookRoutes.clear();
      abortCtl?.abort();
      abortCtl = undefined;
      db = undefined;
      store = undefined;
    },
  };
}
