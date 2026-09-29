import { makeAgentContext, reject, type Plugin, type HookBus } from '@ax/core';
import type { Kysely } from 'kysely';
import { createLimitsStore } from './config.js';
import { runUsageLimitsMigration, type UsageLimitsDatabase } from './migrations.js';
import { createUsageRouteHandlers, registerUsageRoutes } from './routes.js';
import { createUsageService } from './service.js';
import { createUsageStore } from './store.js';

const PLUGIN_NAME = '@ax/usage-limits';

const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Keep 8 days of buckets: the 24h window plus a week of look-back. */
const PRUNE_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

const SUBSCRIBED = ['chat:start', 'chat:resume', 'chat:turn-end', 'llm:usage'] as const;

// ---------------------------------------------------------------------------
// @ax/usage-limits — per-user spend and rate limits (TASK-692).
//
// Launch runs on operator-paid model keys, so one user (or one runaway agent
// loop) could run up the operator's bill. This plugin:
//
//   - GATES every turn on `chat:start` (veto-capable, fired by agent:invoke
//     before a sandbox spawns): suspended, over the daily spend cap, or over
//     the hourly turn cap -> refused with a stable reason code. The gate fails
//     CLOSED: if the check itself breaks, the turn is refused. A parked agent
//     woken by a resolved decision starts a turn without passing agent:invoke,
//     so the same check runs on `chat:resume` (fired by @ax/decisions).
//   - METERS what each turn cost on `chat:turn-end` (runner-reported, so
//     untrusted and parsed defensively) and each host-side helper call on
//     `llm:usage`.
//   - Mounts an admin view + kill switch under /admin/usage.
//
// Registers no service hooks. See docs/plans/2026-09-29-usage-limits.md.
// ---------------------------------------------------------------------------

export interface UsageLimitsPluginConfig {
  /** Injected clock (tests). */
  now?: () => Date;
  /** How often old buckets are pruned. Default 6 hours. */
  pruneIntervalMs?: number;
}

export function createUsageLimitsPlugin(config: UsageLimitsPluginConfig = {}): Plugin {
  const now = config.now ?? (() => new Date());
  const pruneIntervalMs = config.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const unregisterRoutes: Array<() => void> = [];
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  let subscribedBus: HookBus | undefined;

  function teardown(): void {
    if (pruneTimer !== undefined) {
      clearInterval(pruneTimer);
      pruneTimer = undefined;
    }
    if (subscribedBus !== undefined) {
      for (const hook of SUBSCRIBED) subscribedBus.unsubscribe(hook, PLUGIN_NAME);
      subscribedBus = undefined;
    }
    while (unregisterRoutes.length > 0) {
      const fn = unregisterRoutes.pop();
      try {
        fn?.();
      } catch (err) {
        console.warn(
          `[${PLUGIN_NAME}] failed to unregister route: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'database:get-instance',
        'storage:get',
        'storage:set',
        'http:register-route',
        'auth:require-user',
      ],
      optionalCalls: [
        {
          hook: 'auth:get-user',
          degradation:
            'The admin usage view shows user ids instead of display names and emails.',
        },
        {
          hook: 'conversations:list',
          degradation:
            'Suspending a user cannot stop their in-flight turns; their new turns are still refused.',
        },
        {
          hook: 'agent:interrupt',
          degradation:
            'Suspending a user cannot stop their in-flight turns; their new turns are still refused.',
        },
      ],
      subscribes: [...SUBSCRIBED],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      try {
        const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
          'database:get-instance',
          initCtx,
          {},
        );
        const db = shared as Kysely<UsageLimitsDatabase>;
        await runUsageLimitsMigration(db);

        const store = createUsageStore(db);
        const limits = createLimitsStore({ bus, ctx: initCtx, now });
        const service = createUsageService({ store, limits, now });

        unregisterRoutes.push(
          ...(await registerUsageRoutes(
            bus,
            initCtx,
            createUsageRouteHandlers({ bus, store, limits, now }),
          )),
        );

        subscribedBus = bus;
        bus.subscribe<unknown>('chat:start', PLUGIN_NAME, async (ctx) => {
          const decision = await service.admitTurn(ctx);
          // The reason is the bare code; the orchestrator prefixes
          // `chat:start:` itself and channel-web maps it to a sentence.
          if (!decision.ok) return reject({ reason: decision.reason });
          return undefined;
        });
        // A parked agent woken by a resolved decision starts a turn WITHOUT
        // passing agent:invoke (the runner pulls a `decision-resolved` entry),
        // so `chat:start` never sees it. @ax/decisions fires `chat:resume`
        // first, as the decision's owner; it is judged exactly like a start,
        // including counting as a turn, so neither the kill switch nor the
        // caps have a side door.
        bus.subscribe<unknown>('chat:resume', PLUGIN_NAME, async (ctx) => {
          const decision = await service.admitTurn(ctx);
          if (!decision.ok) return reject({ reason: decision.reason });
          return undefined;
        });
        bus.subscribe<unknown>('chat:turn-end', PLUGIN_NAME, async (ctx, payload) => {
          await service.recordTurnEnd(ctx, payload);
          return undefined;
        });
        bus.subscribe<unknown>('llm:usage', PLUGIN_NAME, async (ctx, payload) => {
          await service.recordLlmUsage(ctx, payload);
          return undefined;
        });

        const prune = async (): Promise<void> => {
          try {
            await store.prune(new Date(now().getTime() - PRUNE_RETENTION_MS));
          } catch (err) {
            initCtx.logger.warn('usage_prune_failed', { err });
          }
        };
        await prune();
        pruneTimer = setInterval(() => void prune(), pruneIntervalMs);
        pruneTimer.unref?.();
      } catch (err) {
        teardown();
        throw err;
      }
    },

    async shutdown() {
      teardown();
    },
  };
}
