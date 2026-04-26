import type { Kysely } from 'kysely';
import type { TeamsDatabase } from './migrations.js';

/**
 * Tenant-scoping helper (Invariant I7).
 *
 * `teams:list-for-user` MUST go through this helper. Any other multi-row
 * read of `teams_v1_teams` outside this file or `store.ts` will trip the
 * `local/no-bare-tenant-tables` lint rule.
 *
 * Returns a Kysely query builder pre-filtered to teams where `userId`
 * holds an active membership row. Builder rather than `executeAll(...)`
 * so callers can chain `.orderBy`, `.limit`, etc. without dragging
 * unscoped queries past the helper.
 *
 * No team-id list is taken — membership IS the scope here. Compare with
 * @ax/agents' `scopedAgents`, where the caller provides a `teamIds`
 * list out-of-band; the agents plugin doesn't want a hard dep on
 * @ax/teams's tables (cross-plugin FKs are forbidden — I4). Inside
 * @ax/teams, joining is fine — it's our own data.
 */
export interface TeamScope {
  userId: string;
}

export function scopedTeams(
  db: Kysely<TeamsDatabase>,
  scope: TeamScope,
) {
  return db
    .selectFrom('teams_v1_teams')
    .innerJoin(
      'teams_v1_memberships',
      'teams_v1_teams.team_id',
      'teams_v1_memberships.team_id',
    )
    .selectAll('teams_v1_teams')
    .where('teams_v1_memberships.user_id', '=', scope.userId);
}
