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
