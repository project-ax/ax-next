import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/mcp-oauth owns tables under the `mcp_oauth_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept).
 *
 * Tables:
 *   mcp_oauth_v1_clients  — registered OAuth clients, keyed by `client_key`
 *     (`${connectorId}|${authServerUrl}`). Stores DCR results and admin-pinned
 *     clients. Upserted on each successful registration/re-registration.
 *
 *   mcp_oauth_v1_pending  — single-use pending authorizations, keyed by
 *     `state`. TTL enforced at read time (consumePending). Deleted on first
 *     successful read.
 */
export async function runMcpOAuthMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_oauth_v1_clients (
      client_key    TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      client_secret TEXT,
      dynamic       BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_oauth_v1_pending (
      state         TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      slot          TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      auth_server_url TEXT NOT NULL,
      client_key    TEXT NOT NULL,
      resource      TEXT NOT NULL,
      scope         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  await sql`ALTER TABLE mcp_oauth_v1_pending ADD COLUMN IF NOT EXISTS cred_scope TEXT NOT NULL DEFAULT 'agent'`.execute(db);
}

export interface McpOAuthClientRow {
  client_key: string;
  client_id: string;
  client_secret: string | null;
  dynamic: boolean;
  created_at: Date;
}

export interface McpOAuthPendingRow {
  state: string;
  user_id: string;
  agent_id: string;
  connector_id: string;
  slot: string;
  code_verifier: string;
  auth_server_url: string;
  client_key: string;
  resource: string;
  scope: string | null;
  cred_scope: string;
  created_at: Date;
}

export interface McpOAuthDatabase {
  mcp_oauth_v1_clients: McpOAuthClientRow;
  mcp_oauth_v1_pending: McpOAuthPendingRow;
}
