import type { AgentContext } from '@ax/core';
import type { AttachmentsStore } from './store.js';

export interface JanitorDeps {
  store: AttachmentsStore;
  intervalSeconds: number;
  ctx: AgentContext;
}

export interface JanitorHandle {
  /**
   * Stop the periodic sweep. Clears the timer and awaits any in-flight sweep
   * before resolving so plugin shutdown is clean. Idempotent: calling twice
   * is a no-op.
   */
  stop(): Promise<void>;
}

/**
 * Start a periodic sweep that purges expired temp rows. Performs one sweep
 * synchronously at startup, then schedules subsequent sweeps via setInterval.
 *
 * Errors thrown from `purgeExpired` are caught and logged; the timer keeps
 * running. The handle's `stop()` clears the timer and awaits any in-flight
 * sweep so teardown is clean.
 */
export function startJanitor(deps: JanitorDeps): JanitorHandle {
  // Reject non-positive intervals up front — `setInterval` with 0 or a
  // non-finite ms value will pin a CPU and (with our `sweep` body)
  // hammer the DB, so fail fast on misconfiguration.
  if (!Number.isFinite(deps.intervalSeconds) || deps.intervalSeconds <= 0) {
    throw new Error(
      `attachments janitor intervalSeconds must be > 0 (got ${String(deps.intervalSeconds)})`,
    );
  }

  let inFlight: Promise<void> | null = null;
  let stopped = false;

  async function sweep(): Promise<void> {
    if (stopped) return;
    try {
      const purged = await deps.store.purgeExpired();
      if (purged > 0) {
        deps.ctx.logger.info('attachments_janitor_purged', { count: purged });
      }
    } catch (err) {
      deps.ctx.logger.warn('attachments_janitor_failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  inFlight = sweep();

  const intervalMs = deps.intervalSeconds * 1000;
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = sweep();
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        await inFlight.catch(() => {});
      }
    },
  };
}
