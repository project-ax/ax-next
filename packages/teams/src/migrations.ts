import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/teams owns tables under the `teams_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). Schema version is forward-only via a
 * future `v2` side-table, never an in-place ALTER.
 *
 * Two tables:
 *   teams_v1_teams        — team entity (id, name, creator).
 *   teams_v1_memberships  — many-to-many user↔team with a role enum.
 *
 * No FK to auth_v1_users / agents_v1_agents. Cross-plugin FKs would
 * require shared schema migrations, which violates I4 (no shared rows).
 * Orphan memberships left after a user delete are tolerable — they
 * simply fail every `agents:resolve` ACL check and can be GC'd later.
 *
 * CHECK constraint on role keeps a logic bug from persisting a malformed
 * row. We pre-list 'admin' and 'member' as the only legal values; future
 * roles (e.g., 'owner') would land in a new schema version.
 */
// Schema-agnostic: the executor only needs to issue raw DDL.
export async function runTeamsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS teams_v1_teams (
      team_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS teams_v1_memberships (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id),
      CONSTRAINT teams_v1_memberships_role_check
        CHECK (role IN ('admin', 'member'))
    )
  `.execute(db);

  // Index for the hot read path: `teams:list-for-user` joins memberships
  // by user_id. Without this, every list-for-user call seq-scans the
  // memberships table.
  await sql`
    CREATE INDEX IF NOT EXISTS teams_v1_memberships_user_id_idx
      ON teams_v1_memberships (user_id)
  `.execute(db);
}

/**
 * Row shapes — typed Kysely<TeamsDatabase> catches column drift at
 * compile time and documents the surface (Invariant I4).
 */
export interface TeamRow {
  team_id: string;
  display_name: string;
  created_by: string;
  created_at: Date;
}

export interface MembershipRow {
  team_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
}

export interface TeamsDatabase {
  teams_v1_teams: TeamRow;
  teams_v1_memberships: MembershipRow;
}
