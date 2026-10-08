import { sql, type Kysely } from 'kysely';
import type { ConnectorDatabase } from './migrations.js';

/**
 * Tenant-scoping helper (Invariant I7).
 *
 * Owner-only multi-row reads go through this helper; definition reads (every
 * live connector, any owner) use availableConnectors below. The lint rule `local/no-bare-tenant-tables` enforces that a bare
 * `db.selectFrom('connectors_v1_*')` only appears in `store.ts` / `scope.ts` /
 * test files.
 *
 * Returns a Kysely query builder pre-filtered to:
 *   - rows owned by `scope.userId` (owner_user_id matches),
 *   - non-tombstoned rows (deleted_at IS NULL).
 *
 * Why a builder rather than `executeAll(...)`: callers need to chain
 * `.orderBy` / `.select` / `.where(...)` without dragging an unscoped query
 * builder past the helper.
 *
 * Per-connector reads (`getByIdNotDeleted`) query directly in `store.ts`
 * because they're inside the file the lint rule trusts AND because they carry
 * the same `owner_user_id` predicate inline.
 */
export interface ConnectorScope {
  userId: string;
}

export function scopedConnectors(
  db: Kysely<ConnectorDatabase>,
  scope: ConnectorScope,
) {
  return db
    .selectFrom('connectors_v1_connectors')
    .selectAll('connectors_v1_connectors')
    .where('owner_user_id', '=', scope.userId)
    .where('deleted_at', 'is', null);
}

/**
 * Every live definition is readable by signed-in users (SIGNINS-9: every
 * connector is shared); mutations remain owner-scoped. `scope` is kept so the
 * read stays a per-user call site — the caller's own row still wins a pick.
 */
export function availableConnectors(
  db: Kysely<ConnectorDatabase>,
  _scope: ConnectorScope,
) {
  return db
    .selectFrom('connectors_v1_connectors')
    .selectAll('connectors_v1_connectors')
    .where('deleted_at', 'is', null);
}

/**
 * Authored-draft scope (TASK-94). An authored connector draft is per-(owner,
 * agent), so its scope carries BOTH the owner and the agent — every read MUST
 * filter on both (a draft authored under one agent must never leak into
 * another's namespace). Routed through this helper so the bare-tenant-table
 * read of `connectors_v1_authored` lives in `scope.ts` (lint I7), same as the
 * live-connector read above.
 */
export interface AuthoredConnectorScope {
  ownerUserId: string;
  agentId: string;
}

export function scopedAuthoredConnectors(
  db: Kysely<ConnectorDatabase>,
  scope: AuthoredConnectorScope,
) {
  return db
    .selectFrom('connectors_v1_authored')
    .selectAll('connectors_v1_authored')
    .where('owner_user_id', '=', scope.ownerUserId)
    .where('agent_id', '=', scope.agentId);
}

/**
 * DELIBERATELY UNSCOPED — every owner's PENDING authored drafts (slice 2c:
 * agent proposals go to admins). The only caller is the store's
 * `listPendingAll`, behind `connectors:list-authored-pending-all`, whose only
 * HTTP caller is the adminOnly `GET /admin/connectors/authored`. Routed through
 * this file so the cross-tenant read stays where lint I7 can see it.
 */
export function pendingAuthoredConnectorsForAdmins(db: Kysely<ConnectorDatabase>) {
  return db
    .selectFrom('connectors_v1_authored')
    .selectAll('connectors_v1_authored')
    .where('status', '=', 'pending');
}

/**
 * DELIBERATELY UNSCOPED — delete every authored draft with this connector id,
 * whoever proposed it and under whichever agent, in any status. Two callers,
 * both admin-or-system: creating a live connector (`connectors:upsert` with
 * `created`) resolves the proposals for its id, and the adminOnly Dismiss
 * (`connectors:clear-authored-by-id`). The caller validates the id. Returns the
 * number of rows removed.
 */
export async function clearAuthoredConnectorsByIdForAdmins(
  db: Kysely<ConnectorDatabase>,
  connectorId: string,
): Promise<number> {
  const res = await db
    .deleteFrom('connectors_v1_authored')
    .where('connector_id', '=', connectorId)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0n);
}

/**
 * Does the JSONB `column` declare any `mcpServers` entry with `transport:
 * 'stdio'`? Matches the RAW JSONB (stdio MCP servers were removed 2026-10-04 and
 * the narrowed schema no longer parses such rows). Lax jsonpath: a missing or
 * non-array `mcpServers`, or a non-object document, simply does not match.
 */
export function hasStdioMcpServer(column: 'capabilities' | 'capability_proposal') {
  return sql<boolean>`jsonb_path_exists(${sql.ref(column)}, '$.mcpServers[*] ? (@.transport == "stdio")')`;
}

/**
 * DELIBERATELY UNSCOPED — every owner's live AND tombstoned connector rows that
 * declare a stdio MCP server. The ONLY caller is the boot-time system sweep
 * (stdio-sweep.ts), which runs as `system` during plugin init and hard-deletes
 * these rows; no request path may use it. Routed through this file so the bare
 * cross-tenant read stays where lint I7 can see it.
 */
export function stdioConnectorRowsForSystemSweep(db: Kysely<ConnectorDatabase>) {
  return db
    .selectFrom('connectors_v1_connectors')
    .select(['owner_user_id', 'connector_id', 'key_mode', 'capabilities', 'deleted_at'])
    .where(hasStdioMcpServer('capabilities'));
}

/**
 * DELIBERATELY UNSCOPED — does any OTHER live connector, of ANY owner, that the
 * stdio sweep will NOT delete share `connectorId`? A global credential ref is
 * `account:<connectorId>[:<slot>]` with no owner in it, so when such a row
 * exists the sweep must leave the global key alone: it may be that row's
 * company key. Only the boot-time system sweep (stdio-sweep.ts) calls this.
 */
export async function hasSurvivingSameIdConnectorForSystemSweep(
  db: Kysely<ConnectorDatabase>,
  connectorId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('connectors_v1_connectors')
    .select('owner_user_id')
    .where('connector_id', '=', connectorId)
    .where('deleted_at', 'is', null)
    .where((eb) => eb.not(hasStdioMcpServer('capabilities')))
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * DELIBERATELY UNSCOPED — every owner's LIVE connector rows, identity + the
 * fields a purge derives from. The ONLY caller is the boot-time non-admin
 * sweep (non-admin-sweep.ts, slice 2b), which runs as `system` during plugin
 * init; no request path may use it. Ordered so the sweep is deterministic.
 */
export function liveConnectorRowsForSystemSweep(db: Kysely<ConnectorDatabase>) {
  return db
    .selectFrom('connectors_v1_connectors')
    .select(['owner_user_id', 'connector_id', 'key_mode', 'capabilities'])
    .where('deleted_at', 'is', null)
    .orderBy('owner_user_id', 'asc')
    .orderBy('connector_id', 'asc');
}

/**
 * DELIBERATELY UNSCOPED — does any live connector OTHER than (ownerUserId,
 * connectorId) carry `connectorId`? Asked BEFORE the non-admin sweep
 * tombstones a row, so it answers exactly what `hasLiveById` would answer
 * after it. Only the boot-time non-admin sweep (non-admin-sweep.ts) calls this.
 */
export async function hasOtherLiveSameIdConnectorForSystemSweep(
  db: Kysely<ConnectorDatabase>,
  ownerUserId: string,
  connectorId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('connectors_v1_connectors')
    .select('owner_user_id')
    .where('connector_id', '=', connectorId)
    .where('owner_user_id', '<>', ownerUserId)
    .where('deleted_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * DELIBERATELY UNSCOPED — every owner's LIVE connector rows, identity plus the
 * vestigial `visibility` column, `created_at`, and the key mode + capabilities
 * (for the global refs of an id it must purge): exactly what the one-time
 * SIGNINS-9 boot step (all-shared-step.ts) needs to pick one row per id. The
 * step is the ONLY caller (it runs as `system` during plugin init, inside its
 * own transaction, hence the `db` parameter); no request path may use it.
 * This is the one remaining read of `visibility`.
 */
export function liveRowsForAllSharedStep(db: Kysely<ConnectorDatabase>) {
  return db
    .selectFrom('connectors_v1_connectors')
    .select(['owner_user_id', 'connector_id', 'visibility', 'created_at', 'key_mode', 'capabilities'])
    .where('deleted_at', 'is', null);
}

/**
 * Slice 2b — has the one-shot boot step `name` completed? System-level (no
 * tenant); lives here so the bare `connectors_v1_*` read stays where lint I7
 * can see it. Only boot sweeps call these two.
 */
export async function isBootStepDone(db: Kysely<ConnectorDatabase>, name: string): Promise<boolean> {
  const row = await db
    .selectFrom('connectors_v1_boot_steps')
    .select('name')
    .where('name', '=', name)
    .executeTakeFirst();
  return row !== undefined;
}

/** Record the one-shot boot step `name` as completed (idempotent). */
export async function markBootStepDone(db: Kysely<ConnectorDatabase>, name: string): Promise<void> {
  await db
    .insertInto('connectors_v1_boot_steps')
    .values({ name })
    .onConflict((oc) => oc.column('name').doNothing())
    .execute();
}
