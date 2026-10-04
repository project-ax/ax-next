import { makeAgentContext, type HookBus, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { createSettingsStore } from './config.js';
import { runBlobGcMigration, type BlobGcDatabase } from './migrations.js';
import { createCleanupRouteHandlers, registerCleanupRoutes } from './routes.js';
import { createBlobGcService, type BlobGcService, type SweepResult } from './service.js';
import { PLUGIN_NAME } from './shared.js';
import { createBlobGcStore } from './store.js';

const DEFAULT_SWEEP_INITIAL_DELAY_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const SUBSCRIBED = ['blob:stored'] as const;

// ---------------------------------------------------------------------------
// @ax/blob-gc — finds blobs nobody references any more (TASK-723 design,
// docs/plans/2026-10-03-blob-gc-design.md). THIS CARD (TASK-777) IS REPORT
// MODE ONLY: it finds them, counts them and says so. It frees nothing, and
// it has no hook it could free anything with.
//
//   - RECORDS when each blob was last put (`blob:stored`, which the `blob:put`
//     facade fires after every put, fast path included) in its own
//     `blob_gc_v1_blobs`, design D4.
//   - SWEEPS every `sweepIntervalMs` (default 1 h), only while holding a
//     Postgres advisory lock (another replica sweeping = skip): lists the
//     backend (`blob:list`, D5) to find blobs it has never seen, takes the
//     live ones last put before the grace window (`graceMs`, default 24 h),
//     asks every holder about them through `blob:collect-refs`, and reports
//     `blob_gc_report { mode: 'report', discovered, candidates, held,
//     wouldRetire, wouldRetireBytes, perHolder }`. FAILS CLOSED against its own
//     persisted roster of holders: a holder that failed, threw or is no longer
//     loaded aborts the sweep (`blob_gc_sweep_aborted`) with no report.
//   - SERVES the last report and the settings (`settings:blob-gc`, D8) on
//     GET/PUT /admin/storage/cleanup, for the admin Storage tab's line.
//
// It only FIRES `blob:collect-refs`, so that hook is not in `subscribes`;
// firing needs no manifest entry. Registers no service hooks.
// ---------------------------------------------------------------------------

export interface BlobGcPluginConfig {
  /** Injected clock: `last_put_at`, the grace cutoff and the report time (tests). */
  now?: () => Date;
  /** How long after boot the first sweep runs. Default 5 minutes. */
  sweepInitialDelayMs?: number;
  /** Time between sweeps. Default 1 hour; 0 turns the sweep off. */
  sweepIntervalMs?: number;
}

export interface BlobGcPlugin extends Plugin {
  /** Run one sweep now. Resolves `{ outcome: 'skipped' }` before init. Never throws. */
  sweep(): Promise<SweepResult>;
  /** Resolves once any timer-started sweep has settled. */
  drain(): Promise<void>;
}

export function createBlobGcPlugin(config: BlobGcPluginConfig = {}): BlobGcPlugin {
  const now = config.now ?? (() => new Date());
  const sweepInitialDelayMs = config.sweepInitialDelayMs ?? DEFAULT_SWEEP_INITIAL_DELAY_MS;
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const unregisterRoutes: Array<() => void> = [];
  const sweeps = new Set<Promise<unknown>>();
  let service: BlobGcService | undefined;
  let sweepStartTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let subscribedBus: HookBus | undefined;

  function teardown(): void {
    if (sweepStartTimer !== undefined) {
      clearTimeout(sweepStartTimer);
      sweepStartTimer = undefined;
    }
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
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
        'blob:list',
        'storage:get',
        'storage:set',
        'http:register-route',
        'auth:require-user',
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
        const db = shared as Kysely<BlobGcDatabase>;
        await runBlobGcMigration(db);

        const store = createBlobGcStore(db);
        const settings = createSettingsStore({ bus, ctx: initCtx });
        const svc = createBlobGcService({ bus, store, settings, now, logger: initCtx.logger });
        service = svc;

        unregisterRoutes.push(
          ...(await registerCleanupRoutes(
            bus,
            initCtx,
            createCleanupRouteHandlers({ bus, settings, service: svc }),
          )),
        );

        // Subscribe LAST: everything above can fail. Observe-only, never
        // throws (recordStored catches and logs its own failures).
        subscribedBus = bus;
        bus.subscribe<unknown>('blob:stored', PLUGIN_NAME, async (ctx, payload) => {
          await svc.recordStored(ctx, payload);
          return undefined;
        });

        if (sweepIntervalMs > 0) {
          let sweeping = false;
          const runSweep = (): void => {
            if (sweeping) return;
            sweeping = true;
            const p: Promise<unknown> = svc.sweep().finally(() => {
              sweeping = false;
              sweeps.delete(p);
            });
            sweeps.add(p);
          };
          sweepStartTimer = setTimeout(() => {
            sweepStartTimer = undefined;
            runSweep();
            sweepTimer = setInterval(runSweep, sweepIntervalMs);
            sweepTimer.unref?.();
          }, sweepInitialDelayMs);
          sweepStartTimer.unref?.();
        }
      } catch (err) {
        teardown();
        throw err;
      }
    },

    async shutdown() {
      teardown();
      while (sweeps.size > 0) await Promise.allSettled([...sweeps]);
    },

    async sweep() {
      return service === undefined ? { outcome: 'skipped' } : service.sweep();
    },

    async drain() {
      while (sweeps.size > 0) await Promise.allSettled([...sweeps]);
    },
  };
}
