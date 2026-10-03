import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. `@ax/tool-policy` owns tables under the
 * `tool_policy_v1_` prefix — never reach into them from another plugin
 * (invariant 4, one source of truth per concept). Additive-only, idempotent,
 * re-run on every boot.
 *
 * NO CROSS-PLUGIN FOREIGN KEYS, deliberately, same as `@ax/decisions`.
 * `owner_user_id` is an opaque scoping key, not a reference: a FK onto
 * `auth_better_v1_*` or `agents_v1_*` would drag this table into the shared
 * DROP-TABLE order used by repo-wide test teardown, and that breakage only
 * shows up on a full-repo run. An entry owned by a deleted user is simply
 * never read.
 */
export async function runToolPolicyMigration<DB>(db: Kysely<DB>): Promise<void> {
  // The egress allowlist (TASK-330): hosts `web_extract` may be pointed at
  // without stopping to ask.
  //
  // `owner_user_id` IS NOT NULLABLE, and `''` is the global sentinel. The type
  // (`EgressAllowlistEntry.ownerId`) models global as `null`, which is the
  // honest shape in TypeScript — but a Postgres PRIMARY KEY column cannot hold
  // NULL, and a partial unique index over `scope = 'global'` would be a second
  // uniqueness rule to keep in step with the first. One sentinel, converted at
  // exactly one place (`store.ts`'s `ownerKey`), is the smaller surface.
  // `''` is safe as a sentinel because a user id is never empty — the same
  // shape check that guards `scope: 'user'` writes rejects it.
  await sql`
    CREATE TABLE IF NOT EXISTS tool_policy_v1_egress_allowlist (
      scope         TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      host          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scope, owner_user_id, host)
    )
  `.execute(db);

  // Per-tool verdicts (TASK-736, connectors rail slice 3). Two tables, one
  // concept each: the ADMIN's per-tool default for a connector (a ceiling every
  // agent inherits) and an AGENT's own tighten-only choice.
  //
  // KEYED BY THE TOOL KEY, NOT BY `connector_id`. Connector rows are keyed
  // (owner, id) — a private "linear" and someone else's shared "linear" share
  // an id — so `connector_id` alone cannot identify the record a verdict is
  // about. `tool_namespace` (`c` + 10 hex, minted by @ax/connectors from the
  // row owner + id + server) does, and every toolKey a connector tool reaches
  // the gate under embeds it: `mcp.<tool_namespace>.<tool_name>`. So the PK is
  // (tool_namespace, tool_name) and `connector_id` is a grouping column only.
  await sql`
    CREATE TABLE IF NOT EXISTS tool_policy_v1_connector_defaults (
      connector_id   TEXT NOT NULL,
      tool_namespace TEXT NOT NULL,
      tool_name      TEXT NOT NULL,
      verdict        TEXT NOT NULL,
      updated_by     TEXT NOT NULL,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tool_namespace, tool_name)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS tool_policy_v1_connector_defaults_connector_idx
      ON tool_policy_v1_connector_defaults (connector_id)
  `.execute(db);

  // `origin` says who chose the row: `snapshot` was copied from the admin
  // default when the connector was attached, `user` was picked by a person.
  // A later re-snapshot overwrites `snapshot` rows and never `user` ones.
  await sql`
    CREATE TABLE IF NOT EXISTS tool_policy_v1_agent_overrides (
      agent_id   TEXT NOT NULL,
      tool_key   TEXT NOT NULL,
      verdict    TEXT NOT NULL,
      origin     TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, tool_key)
    )
  `.execute(db);
}

export interface EgressAllowlistRow {
  scope: string;
  owner_user_id: string;
  host: string;
  created_at: Date;
}

export interface ConnectorDefaultRow {
  connector_id: string;
  tool_namespace: string;
  tool_name: string;
  verdict: string;
  updated_by: string;
  updated_at: Date;
}

export interface AgentOverrideRow {
  agent_id: string;
  tool_key: string;
  verdict: string;
  origin: string;
  updated_by: string;
  updated_at: Date;
}

export interface ToolPolicyDatabase {
  tool_policy_v1_egress_allowlist: EgressAllowlistRow;
  tool_policy_v1_connector_defaults: ConnectorDefaultRow;
  tool_policy_v1_agent_overrides: AgentOverrideRow;
}
