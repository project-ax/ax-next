// ---------------------------------------------------------------------------
// Boot-time sweep: hard-delete every stored connector or draft that uses a
// stdio MCP server (removed 2026-10-04 — docs/plans/2026-10-04-drop-stdio-mcp-design.md).
//
// Reads the RAW JSONB, never `rowToConnector`: the narrowed schema refuses
// these rows, which is the whole reason they must go before anything lists.
// Live rows get the same cleanup as `connectors:delete` (key purge + the
// `connectors:deleted` announcement); a tombstone was already cleaned when it
// was soft-deleted. The purge includes GLOBAL refs: this is system cleanup,
// not a caller acting, and it is limited to refs the connector itself derives.
//
// Idempotent — a second boot finds nothing. Logs counts and connector ids only,
// never capability contents.
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AgentContext, HookBus } from '@ax/core';
import type { ConnectorDatabase } from './migrations.js';
import { purgeConnectorState, type PurgeableConnector } from './purge.js';
import { hasStdioMcpServer, stdioConnectorRowsForSystemSweep } from './scope.js';

// Just enough shape to derive the key refs + tool namespaces to clean up.
const PurgeShapeSchema = z.object({
  credentials: z.array(z.object({ slot: z.string(), kind: z.string() }).passthrough()),
  mcpServers: z.array(z.object({ name: z.string() }).passthrough()),
});

export async function sweepStdioConnectors(
  db: Kysely<ConnectorDatabase>,
  bus: HookBus,
  ctx: AgentContext,
): Promise<{ connectors: number; drafts: number }> {
  const rows = await stdioConnectorRowsForSystemSweep(db).execute();

  // Purge BEFORE the hard delete, so a crash in between leaves the row for the
  // next boot to finish (the purge is idempotent) instead of an orphaned key.
  let connectorCount = 0;
  for (const row of rows) {
    if (row.deleted_at === null) {
      const shape = PurgeShapeSchema.safeParse(row.capabilities);
      if (shape.success) {
        const connector = {
          id: row.connector_id,
          keyMode: row.key_mode,
          visibility: row.visibility,
          capabilities: shape.data,
        } as unknown as PurgeableConnector;
        await purgeConnectorState(bus, ctx, row.owner_user_id, connector, { purgeGlobal: true });
      } else {
        ctx.logger.warn('connectors_stdio_sweep_unparseable', { connectorId: row.connector_id });
      }
    }
    const removed = await db
      .deleteFrom('connectors_v1_connectors')
      .where('owner_user_id', '=', row.owner_user_id)
      .where('connector_id', '=', row.connector_id)
      // Re-check at delete time: on a rolling deploy another replica may have
      // replaced this row with a same-id http connector since the SELECT.
      .where(hasStdioMcpServer('capabilities'))
      .executeTakeFirst();
    connectorCount += Number(removed.numDeletedRows ?? 0n);
  }

  const drafts = await db
    .deleteFrom('connectors_v1_authored')
    .where(hasStdioMcpServer('capability_proposal'))
    .executeTakeFirst();
  const draftCount = Number(drafts.numDeletedRows ?? 0n);

  ctx.logger.info('connectors_stdio_swept', { count: connectorCount });
  ctx.logger.info('connectors_authored_stdio_swept', { count: draftCount });
  return { connectors: connectorCount, drafts: draftCount };
}
