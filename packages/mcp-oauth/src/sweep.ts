import type { AgentContext, HookBus, Logger } from '@ax/core';
import type { McpOAuthStore } from './store.js';

// ---------------------------------------------------------------------------
// Slice 5 — boot sweep for agent "sign-in expired" markers whose connector no
// longer exists.
//
// The `connectors:deleted` subscriber drops a deleted connector's markers, but
// an event can be lost (the host died between the delete and the fan-out), and
// a connector deleted before that subscriber existed left its markers behind.
// So at every boot this asks `connectors:live-ids` about each connector id the
// agent marker table still names, and drops the markers (and identity-scope
// skip flags — the same delete the event runs) of every id answered NOT live.
//
// Fails toward keeping data and never throws: connectors not loaded (the CLI
// preset), a throw, or a malformed reply keeps every marker of that batch. A
// stale marker only costs the wrong words on a rail row nobody can see; a
// wrongly dropped one would let a refused token be trusted again (TASK-817).
// No cycle: @ax/connectors never calls this plugin. Reached only through the
// hook (no @ax/connectors import — invariant 2). Mirrors @ax/agents'
// `dropDanglingConnectorIds`.
// ---------------------------------------------------------------------------

// Mirrors @ax/connectors' `LIVE_IDS_MAX` (500), the most ids one
// `connectors:live-ids` call accepts — hard-coded, not imported (invariant 2).
// If connectors ever lowers its cap every call is refused and the sweep fails
// safe into a no-op; keep the two in step.
const LIVE_IDS_BATCH = 500;
// The connector-id grammar `connectors:live-ids` validates. One id outside it
// would make connectors refuse the whole batch, so such an id is never asked
// about (and so never deleted).
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CONNECTOR_ID_MAX = 128;

export interface MarkerSweepDeps {
  bus: HookBus;
  ctx: AgentContext;
  store: Pick<McpOAuthStore, 'listMarkedConnectorIds' | 'deleteMarkersForConnector'>;
  logger: Logger;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Drop agent markers for connector ids no live connector carries. Never throws. */
export async function sweepDeadAgentMarkers(deps: MarkerSweepDeps): Promise<void> {
  const { bus, ctx, store, logger } = deps;
  try {
    if (!bus.hasService('connectors:live-ids')) {
      logger.info('mcp_oauth_marker_sweep_skipped', { reason: 'connectors:live-ids unavailable' });
      return;
    }
    const marked = await store.listMarkedConnectorIds();
    const askable: string[] = [];
    const malformed: string[] = [];
    for (const id of marked) {
      if (id.length <= CONNECTOR_ID_MAX && CONNECTOR_ID_RE.test(id)) askable.push(id);
      else malformed.push(id);
    }
    // Kept, not deleted: we can't ask about it, so we can't be sure it's dead.
    if (malformed.length > 0) {
      logger.warn('mcp_oauth_marker_sweep_malformed_ids', { count: malformed.length });
    }
    let dropped = 0;
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
        logger.warn('mcp_oauth_marker_sweep_lookup_failed', { name: errName(err) });
        continue;
      }
      for (const id of batch) {
        if (live.has(id)) continue;
        try {
          await store.deleteMarkersForConnector(id);
          dropped += 1;
        } catch (err) {
          logger.warn('mcp_oauth_marker_sweep_delete_failed', { connectorId: id, name: errName(err) });
        }
      }
    }
    if (dropped > 0) logger.info('mcp_oauth_marker_sweep_dropped', { connectors: dropped });
  } catch (err) {
    logger.warn('mcp_oauth_marker_sweep_failed', { name: errName(err) });
  }
}
