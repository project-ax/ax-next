import type { ExpressionBuilder, Kysely } from 'kysely';
import type { AgentsDatabase } from './migrations.js';

/**
 * Tenant-scoping helpers (Invariant I7).
 *
 * Every multi-row read of `agents_v1_agents` MUST go through one of these.
 * Single-row resolve-by-id (in `agents:resolve`) is allowed to query
 * directly — but it MUST then call `acl.checkAccess` before returning
 * the row.
 *
 *   - `reachableAgents`: the agents a person can USE, `checkAccess`'s rule in
 *     SQL. Backs `agents:list-for-user`.
 *   - `scopedAgents`: the personal agents a person CREATED, plus team agents of
 *     their teams. Narrower: it ignores co-owners and audiences. Its one caller
 *     is Today's self-changes (identity/store.ts, `teamIds: []`), which lists
 *     what an agent changed about itself for the person who made it.
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

/**
 * Personal agents the user CREATED (`owner_id`, never a co-owner or the
 * audience) plus team agents owned by any team in `scope.teamIds`.
 */
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

/** TASK-1246 — the person a list is for, and what decides their reach. */
export interface ReachableScope {
  userId: string;
  /** Teams the user is a member of; their team agents are included. */
  teamIds: readonly string[];
  /**
   * Is `userId` an AX account (`acl.ts` `isAxAccount`)? Only then does an
   * `everyone` audience reach them. The caller asks auth once per list.
   */
  everyone: boolean;
}

type AgentsEb = ExpressionBuilder<AgentsDatabase, 'agents_v1_agents'>;

/** An owner row for `userId` on the outer query's agent. */
function ownerRowFor(eb: AgentsEb, userId: string) {
  return eb.exists(
    eb
      .selectFrom('agents_v1_owners')
      .select('agents_v1_owners.agent_id')
      .whereRef('agents_v1_owners.agent_id', '=', 'agents_v1_agents.agent_id')
      .where('agents_v1_owners.user_id', '=', userId),
  );
}

/**
 * TASK-1246 — the agents `userId` can use: `checkAccess` (acl.ts) as one SQL
 * filter, so `agents:list-for-user` and `agents:resolve` agree.
 *
 *   - a personal agent (`owner_type = 'user'`), for a non-empty `userId`:
 *     an owner row for them, OR (`scope.everyone` AND audience `everyone`),
 *     OR (audience `list` AND a `user` member row naming them). A member row
 *     under any other audience grants nothing, and an unknown audience matches
 *     no arm (the CHECK refuses one anyway; the store throws on reading one).
 *   - a team agent (`owner_type = 'team'`) of a team in `scope.teamIds`.
 *
 * Selects every agent column plus `is_owner`: does an owner row name `userId`?
 * (The store reports it only for a personal agent.) An empty `userId` reaches
 * no personal agent, as in `checkAccess`; with no teams either, the filter is
 * plain false.
 */
export function reachableAgents(db: Kysely<AgentsDatabase>, scope: ReachableScope) {
  const { userId, teamIds, everyone } = scope;
  return db
    .selectFrom('agents_v1_agents')
    .selectAll('agents_v1_agents')
    .select((eb) => ownerRowFor(eb, userId).as('is_owner'))
    .where((eb) => {
      const arms = [];
      if (userId.length > 0) {
        const admits = [
          ownerRowFor(eb, userId),
          eb.and([
            eb('agents_v1_agents.audience', '=', 'list'),
            eb.exists(
              eb
                .selectFrom('agents_v1_audience_members')
                .select('agents_v1_audience_members.agent_id')
                .whereRef('agents_v1_audience_members.agent_id', '=', 'agents_v1_agents.agent_id')
                .where('agents_v1_audience_members.member_type', '=', 'user')
                .where('agents_v1_audience_members.member_id', '=', userId),
            ),
          ]),
        ];
        if (everyone) admits.push(eb('agents_v1_agents.audience', '=', 'everyone'));
        arms.push(eb.and([eb('agents_v1_agents.owner_type', '=', 'user'), eb.or(admits)]));
      }
      if (teamIds.length > 0) {
        arms.push(
          eb.and([
            eb('agents_v1_agents.owner_type', '=', 'team'),
            eb('agents_v1_agents.owner_id', 'in', [...teamIds]),
          ]),
        );
      }
      // Kysely renders an empty OR as `1 = 0`.
      return eb.or(arms);
    });
}
