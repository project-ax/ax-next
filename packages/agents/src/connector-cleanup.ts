import type { AgentContext, HookBus, Logger } from '@ax/core';
import { validateConnectorId, type AgentStore } from './store.js';

// ---------------------------------------------------------------------------
// Slice 2b — a deleted connector is detached from every agent.
//
// Agents keep connector ids in `connector_attachments` / `connector_exclusions`.
// With no cleanup, deleting a connector and re-creating one with the same id
// silently re-attached the new one to every agent that had the old one (and
// handed it the old sign-in). Two paths close that:
//
//   1. `connectors:deleted` subscriber — when the event says the id is no longer
//      live under ANY owner (`idStillLive === false`), drop it everywhere. A
//      `true` (another owner still has that id) or a missing/non-boolean value
//      (an older payload, or connectors could not check) does nothing: we fail
//      toward KEEPING data.
//   2. Boot sweep — catches ids whose event was lost (host died between the
//      delete and the fan-out) or deleted before this existed. Asks
//      `connectors:live-ids` and drops the ids it says are gone. Absent service
//      or a throw → do nothing.
//
// Neither ever throws. The connectors side is reached only through the
// `connectors:live-ids` hook (no @ax/connectors import — invariant 2).
// ---------------------------------------------------------------------------

export const CONNECTOR_CLEANUP_KEY = '@ax/agents/connector-cleanup';
const LIVE_IDS_BATCH = 500;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ConnectorCleanupDeps {
  store: Pick<AgentStore, 'removeConnectorEverywhere'>;
  logger: Logger;
}

/** Handler for `connectors:deleted`. Never throws. */
export function makeConnectorDeletedHandler(
  deps: ConnectorCleanupDeps,
): (ctx: AgentContext, payload: unknown) => Promise<undefined> {
  return async (_ctx, payload) => {
    try {
      const p = payload as { connectorId?: unknown; idStillLive?: unknown } | null;
      if (p === null || typeof p !== 'object') return undefined;
      if (p.idStillLive !== false) return undefined;
      if (typeof p.connectorId !== 'string' || p.connectorId.length === 0) return undefined;
      const { agents } = await deps.store.removeConnectorEverywhere(p.connectorId);
      deps.logger.info('agents_connector_detached_on_delete', {
        connectorId: p.connectorId,
        agents,
      });
    } catch (err) {
      deps.logger.warn('agents_connector_detach_on_delete_failed', { err: errMessage(err) });
    }
    return undefined;
  };
}

export interface DanglingSweepDeps {
  bus: HookBus;
  ctx: AgentContext;
  store: Pick<AgentStore, 'removeConnectorEverywhere' | 'listReferencedConnectorIds'>;
  logger: Logger;
}

/** Boot sweep: drop attached/excluded ids no live connector has. Never throws. */
export async function dropDanglingConnectorIds(deps: DanglingSweepDeps): Promise<void> {
  const { bus, ctx, store, logger } = deps;
  try {
    if (!bus.hasService('connectors:live-ids')) {
      logger.info('agents_connector_sweep_skipped', { reason: 'connectors:live-ids unavailable' });
      return;
    }
    const referenced = await store.listReferencedConnectorIds();
    const askable: string[] = [];
    const malformed: string[] = [];
    for (const id of referenced) {
      try {
        validateConnectorId(id);
        askable.push(id);
      } catch {
        malformed.push(id);
      }
    }
    // Kept, not deleted: we can't ask about it, so we can't be sure it's dead.
    if (malformed.length > 0) {
      logger.warn('agents_connector_sweep_malformed_ids', { ids: malformed });
    }
    let detached = 0;
    for (let i = 0; i < askable.length; i += LIVE_IDS_BATCH) {
      const batch = askable.slice(i, i + LIVE_IDS_BATCH);
      let live: Set<string>;
      try {
        const out = await bus.call<{ connectorIds: string[] }, { live: string[] }>(
          'connectors:live-ids',
          ctx,
          { connectorIds: batch },
        );
        if (out === null || typeof out !== 'object' || !Array.isArray(out.live)) {
          throw new Error('malformed connectors:live-ids reply');
        }
        live = new Set(out.live);
      } catch (err) {
        // Can't be sure → keep this batch.
        logger.warn('agents_connector_sweep_lookup_failed', { err: errMessage(err) });
        continue;
      }
      for (const id of batch) {
        if (live.has(id)) continue;
        try {
          await store.removeConnectorEverywhere(id);
          detached += 1;
        } catch (err) {
          logger.warn('agents_connector_sweep_detach_failed', { connectorId: id, err: errMessage(err) });
        }
      }
    }
    if (detached > 0) logger.info('agents_connector_sweep_detached', { connectors: detached });
  } catch (err) {
    logger.warn('agents_connector_sweep_failed', { err: errMessage(err) });
  }
}
