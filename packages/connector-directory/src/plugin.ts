import {
  faultLogFields,
  makeAgentContext,
  PluginError,
  type Logger,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import { DIRECTORY_SEARCH_HOOK, DirectorySearchOutputSchema } from './contract.js';
import {
  DEFAULT_REGISTRY_URL,
  DEFAULT_SYNC_INITIAL_DELAY_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  SYNC_BUDGET_MS,
} from './limits.js';
import { runConnectorDirectoryMigration, type ConnectorDirectoryDatabase } from './migrations.js';
import { fetchRegistryPage, parseRegistryUrl, PLUGIN_NAME } from './registry-client.js';
import { parseSearchInput, searchDirectory } from './search.js';
import { createDirectoryStore, type DirectoryStore } from './store.js';
import { runSync, type SyncResult } from './sync.js';

// ---------------------------------------------------------------------------
// @ax/connector-directory — a copy of a public MCP server registry, so Admin ›
// Connectors can search it (TASK-1100; design
// docs/plans/2026-11-09-mcp-directory-connectors-design.md).
//
//   - SYNCS about hourly: `syncInitialDelayMs` after boot, then every
//     `syncIntervalMs` (0 = no timers), from ONE operator-configured https
//     origin (registry-client.ts), into its own `connector_directory_v1_*`
//     tables. One sync at a time: a sync asked for while one runs joins it.
//     Each run has SYNC_BUDGET_MS; shutdown aborts the request in flight and
//     waits for the run to record itself.
//   - ANSWERS `connectors:directory-search` from that copy (search.ts).
//   - OFF (`enabled: false`): no database, no timers, no fetch; the hook
//     still validates its input and answers the fixed off body, so the route
//     and the UI have one shape in every case.
//
// No lock across replicas: the chart runs one host (decisions shard).
// ---------------------------------------------------------------------------

export interface ConnectorDirectoryConfig {
  /** Default true. */
  enabled?: boolean;
  /** Default DEFAULT_REGISTRY_URL. Validated only when enabled. */
  registryUrl?: string;
  /** Default false. Hide listings whose publisher proved only an account. */
  verifiedPublishersOnly?: boolean;
  /** Test seam. Default: the global fetch, looked up at call time. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Default DEFAULT_SYNC_INTERVAL_MS; 0 = no timers (sync() still works). */
  syncIntervalMs?: number;
  /** Default DEFAULT_SYNC_INITIAL_DELAY_MS. */
  syncInitialDelayMs?: number;
}

export interface ConnectorDirectoryPlugin extends Plugin {
  /**
   * Run one sync now, or join the one already running. `{ outcome: 'disabled' }`
   * when off, before init, or after shutdown. Never throws.
   */
  sync(): Promise<SyncResult>;
  /** Resolves once any running sync has settled. */
  drain(): Promise<void>;
}

/**
 * The hook's answer as its `returns` schema reads it. The handlers return the
 * stricter `DirectorySearchOutput`; under exactOptionalPropertyTypes only the
 * schema's own output type types the `returns` option.
 */
type SearchAnswer = z.output<typeof DirectorySearchOutputSchema>;

/** Node runs a timer longer than this after 1 ms: a typo would sync back to back. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function timerDelay(name: string, value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMER_DELAY_MS) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `${name} must be a whole number of milliseconds from 0 to ${MAX_TIMER_DELAY_MS}`,
    });
  }
  return ms;
}

function manifest(calls: string[]): Plugin['manifest'] {
  return {
    name: PLUGIN_NAME,
    version: '0.0.0',
    registers: [DIRECTORY_SEARCH_HOOK],
    calls,
    subscribes: [],
  };
}

const disabled = (): Promise<SyncResult> => Promise.resolve({ outcome: 'disabled' });

function createDisabledPlugin(verifiedOnly: boolean): ConnectorDirectoryPlugin {
  return {
    manifest: manifest([]),
    init({ bus }) {
      bus.registerService<unknown, SearchAnswer>(
        DIRECTORY_SEARCH_HOOK,
        PLUGIN_NAME,
        async (_ctx, input) => {
          parseSearchInput(input);
          return { enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly };
        },
        { returns: DirectorySearchOutputSchema },
      );
    },
    sync: disabled,
    drain: () => Promise.resolve(),
  };
}

export function createConnectorDirectoryPlugin(
  config: ConnectorDirectoryConfig = {},
): ConnectorDirectoryPlugin {
  const verifiedOnly = config.verifiedPublishersOnly ?? false;
  if (config.enabled === false) return createDisabledPlugin(verifiedOnly);

  const base = parseRegistryUrl(config.registryUrl ?? DEFAULT_REGISTRY_URL);
  const syncIntervalMs = timerDelay('syncIntervalMs', config.syncIntervalMs, DEFAULT_SYNC_INTERVAL_MS);
  const syncInitialDelayMs = timerDelay(
    'syncInitialDelayMs',
    config.syncInitialDelayMs,
    DEFAULT_SYNC_INITIAL_DELAY_MS,
  );
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = config.now ?? (() => new Date());
  // Aborted once, at shutdown: the request in flight, and every later page.
  const stopping = new AbortController();
  let running: { store: DirectoryStore; logger: Logger } | undefined;
  let inflight: Promise<SyncResult> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  function clearTimers(): void {
    if (startTimer !== undefined) {
      clearTimeout(startTimer);
      startTimer = undefined;
    }
    if (intervalTimer !== undefined) {
      clearInterval(intervalTimer);
      intervalTimer = undefined;
    }
  }

  async function runOnce(store: DirectoryStore, logger: Logger): Promise<SyncResult> {
    try {
      // One budget for the whole run, shared by every page.
      const signal = AbortSignal.any([AbortSignal.timeout(SYNC_BUDGET_MS), stopping.signal]);
      return await runSync({
        store,
        source: base.href,
        fetchPage: (q) => fetchRegistryPage(fetchImpl, base, q, { signal }),
        now,
        logger,
      });
    } catch (err) {
      // runSync never throws; this keeps a timer's dropped promise from ever
      // becoming an unhandled rejection that would end the host.
      try {
        logger.warn('connector_directory_sync_failed', { reason: 'store', ...faultLogFields(err) });
      } catch {
        // Nothing left to report it with.
      }
      return { outcome: 'failed', reason: 'store' };
    }
  }

  function sync(): Promise<SyncResult> {
    if (inflight !== undefined) return inflight;
    if (running === undefined || stopping.signal.aborted) return disabled();
    const run = runOnce(running.store, running.logger).finally(() => {
      inflight = undefined;
    });
    inflight = run;
    return run;
  }

  async function settled(): Promise<void> {
    while (inflight !== undefined) await inflight;
  }

  return {
    manifest: manifest(['database:get-instance']),

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
        const db = shared as Kysely<ConnectorDirectoryDatabase>;
        await runConnectorDirectoryMigration(db);

        bus.registerService<unknown, SearchAnswer>(
          DIRECTORY_SEARCH_HOOK,
          PLUGIN_NAME,
          (_ctx, input) => searchDirectory(db, input, { verifiedOnly }),
          { returns: DirectorySearchOutputSchema },
        );
        running = { store: createDirectoryStore(db), logger: initCtx.logger };

        if (syncIntervalMs > 0) {
          startTimer = setTimeout(() => {
            startTimer = undefined;
            void sync();
            intervalTimer = setInterval(() => void sync(), syncIntervalMs);
            intervalTimer.unref?.();
          }, syncInitialDelayMs);
          startTimer.unref?.();
        }
      } catch (err) {
        clearTimers();
        running = undefined;
        throw err;
      }
    },

    async shutdown() {
      clearTimers();
      stopping.abort();
      await settled();
    },

    sync,

    drain: settled,
  };
}
