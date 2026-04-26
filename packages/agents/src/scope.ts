import type { Kysely } from 'kysely';
import type { AgentsDatabase } from './migrations.js';

/**
 * Tenant-scoping helper (Invariant I7).
 *
 * Every multi-row read of `agents_v1_agents` MUST go through this helper.
 * Single-row resolve-by-id (in `agents:resolve`) is allowed to query
 * directly — but it MUST then call `acl.checkAccess` before returning
 * the row.
 *
 * Returns a Kysely query builder pre-filtered to the agents the caller
 * can reach:
 *   - personal agents owned by `scope.userId` (owner_type='user'), OR
 *   - team agents owned by any team in `scope.teamIds` (owner_type='team').
 *
 * `scope.teamIds === []` collapses the team branch entirely — the resulting
 * SQL has no `IN ()` (which would be invalid in postgres).
 *
 * Why a builder rather than `executeAll(...)`: callers need to chain
 * `.orderBy`, `.limit`, `.where('display_name', 'ilike', …)` etc. without
 * dragging unscoped query builders past the helper.
 */
export interface AgentScope {
  userId: string;
  teamIds: readonly string[];
}

export function scopedAgents(
  db: Kysely<AgentsDatabase>,
  scope: AgentScope,
) {
  const teamIds = scope.teamIds;
  return db
    .selectFrom('agents_v1_agents')
    .selectAll('agents_v1_agents')
    .where((eb) => {
      const personal = eb.and([
        eb('owner_type', '=', 'user'),
        eb('owner_id', '=', scope.userId),
      ]);
      if (teamIds.length === 0) {
        return personal;
      }
      const team = eb.and([
        eb('owner_type', '=', 'team'),
        eb('owner_id', 'in', [...teamIds]),
      ]);
      return eb.or([personal, team]);
    });
}
