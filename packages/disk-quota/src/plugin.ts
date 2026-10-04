import {
  makeAgentContext,
  reject,
  type HookBus,
  type Plugin,
  type Rejection,
  type WorkspaceDeletedPayload,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { createLimitsStore } from './config.js';
import { runDiskQuotaMigration, type DiskQuotaDatabase } from './migrations.js';
import { createStorageRouteHandlers, registerStorageRoutes } from './routes.js';
import {
  cleanSize,
  createDiskQuotaService,
  type DiskQuotaService,
  type ReconcileResult,
} from './service.js';
import { PLUGIN_NAME } from './shared.js';
import { createDiskQuotaStore } from './store.js';

const DEFAULT_SWEEP_INITIAL_DELAY_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SUBSCRIBED = [
  'workspace:pre-apply',
  'workspace:applied',
  'blob:pre-put',
  'blob:stored',
  'chat:start',
  'workspace:deleted',
] as const;

// ---------------------------------------------------------------------------
// @ax/disk-quota — a per-owner storage limit (TASK-690).
//
// Prod keeps every agent workspace (bare git repos) and every uploaded or
// published file on ONE shared volume, and nothing limited how much of it one
// person could use. This plugin:
//
//   - GATES every write where the bytes are written. `workspace:pre-apply`
//     (veto-capable; fires on the runner's commit AND on every in-process
//     `workspace:apply`) and `blob:pre-put` (veto-capable; fired by the
//     `blob:put` facade before any backend is touched) are refused when
//     `used + incoming > limit`. The gates fail CLOSED: if the check itself
//     breaks, the write is refused.
//   - TURNS AWAY a full person's next message at `chat:start` (reason
//     `storage-full`, which channel-web turns into a sentence). The refused
//     end-of-turn save itself is reported under that reply (the veto's `code`
//     rides the commit answer, the runner reports it on `event.turn-end` as
//     `saveRefused`, TASK-720); this gate is what stops the person starting
//     another turn whose files cannot be kept either. This one fails OPEN: it
//     exists for the message; the write gates above are the guard.
//   - METERS what was stored. `blob:stored` charges the writer (one row per
//     owner and sha, so a re-put is free); `workspace:applied` re-measures
//     that agent's repo in the background; a periodic sweep backfills every
//     personal agent and repairs drift. `workspace:deleted` (the agent's repo is
//     gone) drops that agent's row, so a deleted agent stops charging its owner.
//   - RELEASES blob charges nobody holds any more (design D6,
//     docs/plans/2026-10-03-blob-gc-design.md). The same periodic sweep runs a
//     blob pass: `blob:<sha>` rows older than the grace window (`graceMs` in
//     `settings:disk-quota`, default 24 h) are offered, in batches of at most
//     1000 shas, to every holder through `blob:collect-refs`, and an (owner,
//     sha) row goes when no holder attributes that sha to that owner. It FAILS
//     CLOSED against a persisted roster of holders (a holder that failed,
//     threw or is no longer loaded aborts the pass with nothing released) and
//     needs none of the workspace sweep's optional hooks.
//     `POST /admin/storage/ref-holders/forget` is the only way the roster
//     shrinks. This plugin only FIRES `blob:collect-refs`, so it is not in
//     `subscribes`; firing needs no manifest entry.
//   - Mounts the usage views under /settings/storage and /admin/storage.
//
// Registers no service hooks. See docs/plans/2026-09-29-workspace-disk-quota.md.
// ---------------------------------------------------------------------------

export interface DiskQuotaPluginConfig {
  /** Injected clock for the limit setting's cache and the blob pass's grace cutoff (tests). */
  now?: () => Date;
  /** How long after boot the first sweep runs. Default 60 s. */
  sweepInitialDelayMs?: number;
  /** Time between sweeps. Default 6 hours; 0 turns the sweep off. */
  sweepIntervalMs?: number;
  /** How long a read of the limit setting is reused. Default 15 s. */
  limitsCacheTtlMs?: number;
}

export interface DiskQuotaPlugin extends Plugin {
  /** Resolves once background measurements and any running sweep have settled. */
  drain(): Promise<void>;
  /** Run the sweep (workspaces, then the blob pass) now. Resolves all zeros before init. */
  reconcile(): Promise<ReconcileResult>;
}

function sizeField(payload: unknown, key: string): number {
  if (payload === null || typeof payload !== 'object') return 0;
  return cleanSize((payload as Record<string, unknown>)[key]);
}

/**
 * The `agentId` of a `workspace:deleted` payload as sent, else undefined. The
 * type says what a well-behaved publisher sends; the value is still untrusted,
 * so it comes back as `unknown` for the service to validate.
 */
function agentIdField(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  return (payload as Partial<WorkspaceDeletedPayload>).agentId;
}

/**
 * The veto for a refused write: the sentence, plus the machine-readable code
 * when the refusal carries one (only "storage is full" does). The key is built
 * only when present, so the fail-closed refusal has no `code` at all.
 */
function vetoFor(decision: { reason: string; code?: string }): Rejection {
  return reject({
    reason: decision.reason,
    ...(decision.code !== undefined ? { code: decision.code } : {}),
  });
}

export function createDiskQuotaPlugin(config: DiskQuotaPluginConfig = {}): DiskQuotaPlugin {
  const now = config.now ?? (() => new Date());
  const sweepInitialDelayMs = config.sweepInitialDelayMs ?? DEFAULT_SWEEP_INITIAL_DELAY_MS;
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const unregisterRoutes: Array<() => void> = [];
  const sweeps = new Set<Promise<unknown>>();
  let service: DiskQuotaService | undefined;
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
        'storage:get',
        'storage:set',
        'http:register-route',
        'auth:require-user',
      ],
      optionalCalls: [
        {
          hook: 'workspace:usage',
          degradation:
            "Workspace bytes are not measured, so only a person's uploaded and published files count toward their storage limit.",
        },
        {
          hook: 'agents:resolve',
          degradation:
            "A team agent's workspace is charged to the person who made the change instead of to the team.",
        },
        {
          hook: 'agents:list-personal-owners',
          degradation:
            'The periodic sweep is skipped, so workspaces that existed before this plugin shipped (or that drifted) are only counted after their next write.',
        },
        {
          hook: 'auth:get-user',
          degradation: 'The admin storage view shows user ids instead of display names and emails.',
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
        const db = shared as Kysely<DiskQuotaDatabase>;
        await runDiskQuotaMigration(db);

        const store = createDiskQuotaStore(db);
        const limits = createLimitsStore({
          bus,
          ctx: initCtx,
          now,
          ...(config.limitsCacheTtlMs !== undefined ? { ttlMs: config.limitsCacheTtlMs } : {}),
        });
        const svc = createDiskQuotaService({ bus, store, limits, logger: initCtx.logger, now });
        service = svc;

        unregisterRoutes.push(
          ...(await registerStorageRoutes(
            bus,
            initCtx,
            createStorageRouteHandlers({ bus, store, limits }),
          )),
        );

        // Subscribe LAST: everything above can fail, and a half-initialised
        // plugin must not leave gates behind.
        subscribedBus = bus;
        // The reasons are PROSE and are shown verbatim (to the agent on the
        // runner-commit path, to the person on the upload paths). A refusal
        // because storage is full also carries `code: 'storage-full'`, for a
        // caller that has to tell that apart without reading the sentence.
        bus.subscribe<unknown>('workspace:pre-apply', PLUGIN_NAME, async (ctx, payload) => {
          const decision = await svc.admitWorkspaceWrite(ctx, sizeField(payload, 'sizeBytes'));
          if (!decision.ok) return vetoFor(decision);
          return undefined;
        });
        bus.subscribe<unknown>('blob:pre-put', PLUGIN_NAME, async (ctx, payload) => {
          const decision = await svc.admitBlobWrite(ctx, sizeField(payload, 'size'));
          if (!decision.ok) return vetoFor(decision);
          return undefined;
        });
        // The front door. The write gates above are the hard guard; a refused
        // end-of-turn save is reported under the reply it belonged to
        // (`saveRefused` on `event.turn-end`, TASK-720). Turning their NEXT
        // message away here, with a code channel-web turns into a sentence
        // (`chat:start:storage-full`), stops a full person running another turn
        // whose files would be thrown away too. Fails OPEN (see admitTurn): it
        // exists for the message, not for the disk.
        bus.subscribe<unknown>('chat:start', PLUGIN_NAME, async (ctx) => {
          const decision = await svc.admitTurn(ctx);
          if (!decision.ok) return reject({ reason: decision.reason });
          return undefined;
        });
        // Observers: never awaited past the cheap ledger write, never throw.
        bus.subscribe<unknown>('blob:stored', PLUGIN_NAME, async (ctx, payload) => {
          await svc.recordBlobStored(ctx, payload);
          return undefined;
        });
        bus.subscribe<unknown>('workspace:applied', PLUGIN_NAME, async (ctx) => {
          // Re-measuring walks a repo directory, so it happens off the
          // write's path. The payload is a delta and is deliberately ignored.
          svc.scheduleWorkspaceMeasure(ctx);
          return undefined;
        });
        // The agent's repo is gone (the deleter fires this after removing it),
        // so its bytes are free: drop the row rather than charge the owner for a
        // workspace that no longer exists. The payload is untrusted; the service
        // validates it, never throws, and logs its own failures.
        bus.subscribe<unknown>('workspace:deleted', PLUGIN_NAME, async (_ctx, payload) => {
          await svc.releaseWorkspace(agentIdField(payload));
          return undefined;
        });

        if (sweepIntervalMs > 0) {
          let sweeping = false;
          const runSweep = (): void => {
            if (sweeping) return;
            sweeping = true;
            const p: Promise<unknown> = svc.reconcile().finally(() => {
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
    },

    async drain() {
      await service?.drain();
      while (sweeps.size > 0) await Promise.allSettled([...sweeps]);
    },

    async reconcile() {
      return service === undefined
        ? { measured: 0, failed: 0, blobsReleased: 0, blobReleaseAborted: false }
        : service.reconcile();
    },
  };
}
