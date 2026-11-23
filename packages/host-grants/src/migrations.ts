import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/host-grants owns tables under the
 * `host_grants_v1_` prefix — never reach into them from another plugin
 * (Invariant I4 — one source of truth per concept). Additive-only.
 *
 * host_grants_v1_grants — each agent's persistent "always-allow" egress host
 * list (JIT design §6B / §P7.3). TASK-1212 made the list the agent's, not the
 * per-(user, agent) one of decision #12: `owner_user_id` now records who added
 * a row, and the PK keeps one row per (adder, agent, host). The durable twin
 * of the LIVE proxy:add-host grant (TASK-37): the orchestrator loads the
 * agent's hosts into the egress allowlist at every fresh session open.
 * `agent_id` is an opaque scoping key — no FK to agents_v1_agents (cross-plugin
 * FKs are banned), so deleting an agent does not cascade here: this plugin
 * subscribes to `agents:deleted` and removes the agent's rows itself (TASK-718).
 *
 * host_grants_v1_grants_agent_host backs the per-agent reads (list, the cap,
 * the duplicate check, revoke), which the PK can't serve: it leads with
 * owner_user_id.
 */
export async function runHostGrantsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS host_grants_v1_grants (
      owner_user_id TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      host          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, agent_id, host)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS host_grants_v1_grants_agent_host
      ON host_grants_v1_grants (agent_id, host)
  `.execute(db);
}

/** Row shape returned by postgres. */
export interface HostGrantRow {
  owner_user_id: string;
  agent_id: string;
  host: string;
  created_at: Date;
}

export interface HostGrantsDatabase {
  host_grants_v1_grants: HostGrantRow;
}
