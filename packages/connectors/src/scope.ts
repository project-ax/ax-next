import type { Kysely } from 'kysely';
import type { ConnectorDatabase } from './migrations.js';

/**
 * Tenant-scoping helper (Invariant I7).
 *
 * Every multi-row read of `connectors_v1_connectors` MUST go through this
 * helper. The lint rule `local/no-bare-tenant-tables` enforces that a bare
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
 * Owner-only authored-draft scope — every draft the user owns ACROSS all their
 * agents (no agent_id predicate). Backs `listPendingForUser`, the Settings
 * "Proposed by your assistant" fallback: a connector proposed mid-turn is
 * per-(owner, agent), but the user shouldn't have to know which agent proposed
 * it, so the fallback aggregates by owner. Routed through this helper so the
 * bare-tenant-table read lives in `scope.ts` (lint I7), same as the scoped reads
 * above. Still owner-scoped — a foreign user's draft can never be observed.
 */
export function scopedAuthoredConnectorsByUser(
  db: Kysely<ConnectorDatabase>,
  scope: { userId: string },
) {
  return db
    .selectFrom('connectors_v1_authored')
    .selectAll('connectors_v1_authored')
    .where('owner_user_id', '=', scope.userId);
}
