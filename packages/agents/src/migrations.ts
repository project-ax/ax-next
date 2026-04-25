import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/agents owns tables under the `agents_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). Schema version is forward-only via a
 * future `v2` side-table, never an in-place ALTER.
 *
 * Single table:
 *   agents_v1_agents  — agent entity, owned by user_id OR team_id.
 *
 * No FK to auth_v1_users / teams_v1_teams. Cross-plugin FKs would
 * require shared schema migrations, which violates I4 (no shared rows).
 * The runtime ACL gate checks ownership against the live row at
 * resolve-time; orphan rows after a user/team delete are tolerable
 * (they simply fail every `agents:resolve` and can be GC'd later).
 *
 * CHECK constraints:
 *   - owner_type IN ('user','team') and visibility IN ('personal','team')
 *     are domain enums; SQL-level enforcement keeps a logic bug from
 *     persisting a malformed row.
 *   - owner_type/visibility pairing — `personal` MUST be owned by `user`
 *     and `team` by `team`. Without this, someone could insert a row
 *     where ACL would have to fall back to "deny by default" forever.
 */
// Schema-agnostic: the executor only needs to issue raw DDL.
export async function runAgentsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS agents_v1_agents (
      agent_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      visibility TEXT NOT NULL,
      display_name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      allowed_tools JSONB NOT NULL,
      mcp_config_ids JSONB NOT NULL,
      model TEXT NOT NULL,
      workspace_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT agents_v1_owner_type_check
        CHECK (owner_type IN ('user', 'team')),
      CONSTRAINT agents_v1_visibility_check
        CHECK (visibility IN ('personal', 'team')),
      CONSTRAINT agents_v1_owner_visibility_pair_check
        CHECK (
          (owner_type = 'user' AND visibility = 'personal')
          OR (owner_type = 'team' AND visibility = 'team')
        )
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS agents_v1_agents_owner
      ON agents_v1_agents (owner_type, owner_id)
  `.execute(db);
}

/**
 * Row shape — the JSONB columns deserialize to `unknown` until validated.
 * Store helpers parse/validate before returning to plugin code.
 */
export interface AgentsRow {
  agent_id: string;
  owner_id: string;
  owner_type: string;
  visibility: string;
  display_name: string;
  system_prompt: string;
  allowed_tools: unknown;
  mcp_config_ids: unknown;
  model: string;
  workspace_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentsDatabase {
  agents_v1_agents: AgentsRow;
}
