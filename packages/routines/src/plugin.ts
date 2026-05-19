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
import { createSeedHeartbeatSubscriber } from './seed-heartbeat.js';
import { parseRoutineRow } from './parse-routine.js';
import { durationToSeconds } from '@ax/validator-routine';
import type {
  RoutinesConfig,
  FireNowInput,
  FireNowOutput,
  ListInput,
  ListOutput,
  RecentFiresInput,
  RecentFiresOutput,
  RoutinesListDefaultsInput,
  RoutinesListDefaultsOutput,
  RoutinesGetDefaultInput,
  RoutinesGetDefaultOutput,
  RoutinesUpsertDefaultInput,
  RoutinesUpsertDefaultOutput,
  RoutinesDeleteDefaultInput,
  RoutinesDeleteDefaultOutput,
} from './types.js';

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
      registers: [
        'routines:fire-now',
        'routines:list',
        'routines:recent-fires',
        'routines:list-defaults',
        'routines:get-default',
        'routines:upsert-default',
        'routines:delete-default',
      ],
      calls: [
        'database:get-instance',
        'agents:resolve',
        'agents:ensure-webhook-token',
        'agents:resolve-by-webhook-token',
        'agents:list-ids',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
        'credentials:get',
        'http:register-route',
        'workspace:apply',
      ],
      subscribes: ['workspace:applied', 'chat:turn-end', 'agents:webhook-token-rotated', 'agents:created'],
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
              renderedPrompt: pf.renderedPrompt,
            });
          } else {
            await localStore.recordFire({
              agentId: pf.row.agentId, path: pf.row.path,
              triggerSource: pf.source,
              conversationId: pf.conversationId,
              status: 'ok', error: null,
              renderedPrompt: pf.renderedPrompt,
            });
          }
        } catch (err) {
          ctx.logger.warn('routines_turn_end_handler_failed', {
            reqId, err: err instanceof Error ? err.message : String(err),
          });
        }
        return undefined;
      });

      bus.subscribe<{ agentId: string; ownerId: string; ownerType: 'user' | 'team' }>(
        'agents:created', PLUGIN_NAME,
        createSeedHeartbeatSubscriber({ bus }),
      );

      bus.registerService<ListInput, ListOutput>(
        'routines:list', PLUGIN_NAME,
        async (_ctx, input) => {
          const filter: { agentId?: string } = {};
          if (input.agentId !== undefined) filter.agentId = input.agentId;
          const routines = await localStore.list(filter);
          return { routines };
        },
      );

      bus.registerService<RecentFiresInput, RecentFiresOutput>(
        'routines:recent-fires', PLUGIN_NAME,
        async (_ctx, input) => {
          const fires = await localStore.recentFires(input);
          return { fires };
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
          // Normalize once so the executor and the audit row see the
          // same value. A caller passing source='webhook' runs as
          // manual; persisting raw `source` here would leave the
          // fires_v1 audit trail saying "webhook" for a fire that the
          // template engine actually ran as a manual.
          const effectiveSource: 'tick' | 'manual' =
            source === 'tick' ? 'tick' : 'manual';
          const result = await fireRoutine(row, effectiveSource, input.payload);
          const fireId = await localStore.recordFire({
            agentId: row.agentId, path: row.path,
            triggerSource: effectiveSource,
            conversationId: result.conversationId ?? null,
            status: result.status,
            error: result.error,
            renderedPrompt: result.renderedPrompt,
          });
          return {
            fireId,
            status: result.status,
            conversationId: result.conversationId ?? null,
          };
        },
      );

      bus.registerService<RoutinesListDefaultsInput, RoutinesListDefaultsOutput>(
        'routines:list-defaults', PLUGIN_NAME,
        async () => {
          const rows = await localStore.listDefaults();
          return {
            defaults: rows.map((r) => ({
              defaultRoutineId: r.defaultRoutineId,
              name: r.name,
              description: r.description,
              trigger: r.trigger,
              enabled: r.enabled,
              updatedAt: r.updatedAt.toISOString(),
            })),
          };
        },
      );

      bus.registerService<RoutinesGetDefaultInput, RoutinesGetDefaultOutput>(
        'routines:get-default', PLUGIN_NAME,
        async (_ctx, input) => {
          const row = await localStore.getDefault(input.defaultRoutineId);
          if (row === null) {
            throw new PluginError({
              code: 'not-found', plugin: PLUGIN_NAME,
              hookName: 'routines:get-default',
              message: `default routine '${input.defaultRoutineId}' not found`,
            });
          }
          return {
            defaultRoutineId: row.defaultRoutineId,
            name: row.name,
            description: row.description,
            trigger: row.trigger,
            enabled: row.enabled,
            updatedAt: row.updatedAt.toISOString(),
            sourceMd: row.sourceMd,
            silenceToken: row.silenceToken,
            silenceMax: row.silenceMax,
            conversation: row.conversation,
            activeHours: row.activeHours,
            promptBody: row.promptBody,
          };
        },
      );

      bus.registerService<RoutinesUpsertDefaultInput, RoutinesUpsertDefaultOutput>(
        'routines:upsert-default', PLUGIN_NAME,
        async (_ctx, input) => {
          const parsed = parseRoutineRow(new TextEncoder().encode(input.sourceMd));
          if (!parsed.ok) {
            throw new PluginError({
              code: 'invalid-routine-md', plugin: PLUGIN_NAME,
              hookName: 'routines:upsert-default',
              message: parsed.reason,
            });
          }
          if (parsed.fields.trigger.kind === 'webhook') {
            throw new PluginError({
              code: 'default-trigger-webhook-not-supported', plugin: PLUGIN_NAME,
              hookName: 'routines:upsert-default',
              message: 'default routines do not support webhook triggers in v1',
            });
          }
          if (parsed.fields.trigger.kind === 'cron') {
            throw new PluginError({
              code: 'default-trigger-cron-not-supported', plugin: PLUGIN_NAME,
              hookName: 'routines:upsert-default',
              message: 'default routines support interval triggers only in v1',
            });
          }
          // trigger.kind is now narrowed to 'interval'
          const intervalSeconds = durationToSeconds(parsed.fields.trigger.every) ?? 0;
          if (intervalSeconds <= 0) {
            throw new PluginError({
              code: 'invalid-interval', plugin: PLUGIN_NAME,
              hookName: 'routines:upsert-default',
              message: 'interval must resolve to a positive duration',
            });
          }
          return localStore.upsertDefault({
            name: parsed.fields.name,
            description: parsed.fields.description,
            specHash: parsed.specHash,
            trigger: parsed.fields.trigger,
            intervalSeconds,
            activeHours: parsed.fields.activeHours ?? null,
            silenceToken: parsed.fields.silenceToken ?? null,
            silenceMax: parsed.fields.silenceMaxChars,
            conversation: parsed.fields.conversation,
            promptBody: parsed.fields.promptBody,
            sourceMd: input.sourceMd,
          });
        },
      );

      bus.registerService<RoutinesDeleteDefaultInput, RoutinesDeleteDefaultOutput>(
        'routines:delete-default', PLUGIN_NAME,
        async (_ctx, input) => {
          await localStore.deleteDefault(input.defaultRoutineId);
          return {};
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

      // Adapt agents:list-ids → getAgentIds callback so tick.ts stays
      // free of HookBus imports. Failures inside the bus call surface
      // as a thrown promise inside runTickOnce, where the I-R10 try/catch
      // logs and continues (workspace claims still fire).
      const getAgentIds = async (): Promise<string[]> => {
        const r = await bus.call<Record<string, never>, { agentIds: string[] }>(
          'agents:list-ids', initCtx, {},
        );
        return r.agentIds;
      };

      abortCtl = new AbortController();
      void runTickLoop({
        db: localDb, fire: fireRoutine, getAgentIds, clock,
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
