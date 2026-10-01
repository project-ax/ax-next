import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/mcp-oauth owns tables under the `mcp_oauth_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept).
 *
 * Tables:
 *   mcp_oauth_v1_clients  — READ-ONLY legacy fallback. It once held ONE OAuth client
 *     per `client_key` (`${connectorId}|${authServerUrl}`), overwritten on every
 *     `begin` — which is the bug TASK-696 fixed: a token was redeemed/refreshed as
 *     whichever client registered LAST, not the one it was issued to. Nothing
 *     writes it any more; a token blob or pending row from before that fix (no
 *     client of its own) is still resolved through it via `getClient`.
 *
 *   mcp_oauth_v1_pending  — single-use pending authorizations, keyed by
 *     `state`. TTL enforced at read time (consumePending). Deleted on first
 *     successful read, purged once older than the TTL (purgeExpiredPending), or
 *     dropped when its agent is deleted (`agents:deleted` → deleteAllForAgent;
 *     TASK-718 — there is no FK to the agents table, deliberately).
 *     Carries the OAuth client the authorization started with (`client_id`,
 *     nullable `client_secret`) so the callback redeems the code as that client;
 *     both are NULL on a row written before TASK-696.
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
  await sql`ALTER TABLE mcp_oauth_v1_pending ADD COLUMN IF NOT EXISTS client_id TEXT`.execute(db);
  await sql`ALTER TABLE mcp_oauth_v1_pending ADD COLUMN IF NOT EXISTS client_secret TEXT`.execute(db);
  await sql`ALTER TABLE mcp_oauth_v1_pending ADD COLUMN IF NOT EXISTS issuer_required BOOLEAN NOT NULL DEFAULT false`.execute(db);
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
  issuer_required: boolean;
  client_key: string;
  resource: string;
  scope: string | null;
  cred_scope: string;
  /** The client this authorization started with; NULL on a pre-TASK-696 row. */
  client_id: string | null;
  client_secret: string | null;
  created_at: Date;
}

export interface McpOAuthDatabase {
  mcp_oauth_v1_clients: McpOAuthClientRow;
  mcp_oauth_v1_pending: McpOAuthPendingRow;
}
