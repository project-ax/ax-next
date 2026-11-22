import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/apps-bridge owns the tables under the `apps_bridge_v1_` prefix
 * (invariant 4: one source of truth). Nothing else reads or writes them, and
 * every query against them lives in store.ts.
 *
 *   apps_bridge_v1_link_codes — open link codes. A person mints one in their
 *     agent's settings and pastes it into an outside app, which claims it to
 *     link itself to that agent. Only `sha256(code)` (hex) is kept, never the
 *     code, and a CHECK refuses anything but 64 lowercase hex characters, so
 *     a raw code can't land here by mistake. `created_at` is written from the caller's clock, the same clock
 *     that decides expiry, so "the newest 10 per agent" is deterministic.
 *
 *   apps_bridge_v1_links — one row per linked app: which agent an outside
 *     app (`app_id`, the platform's opaque id) borrows connectors from, on
 *     which platform. The primary key makes it one agent per app id.
 *     `app_name` is display-only and already normalized. `link_code_hash` is
 *     the hash of the code that made the link (same hex-only CHECK), so a
 *     retried claim of that code can be answered with the same link.
 *
 *   apps_bridge_v1_grants — which of the linked agent's connectors the app
 *     may call, in which mode, and which tools (`tool_keys`, in the order
 *     they were saved). Unlinking cascades them away. They carry no
 *     `agent_id`: the link they hang off names the agent.
 *
 *   apps_bridge_v1_viewer_approvals — a viewer's consent to a viewer-mode
 *     grant: the personal agent (`agent_id`) whose connector sign-in the app
 *     borrows for them, and the tools they approved (a snapshot). Removing
 *     the grant, or the link under it, cascades them away.
 *
 * The cascades are this plugin's own rows only. Nothing here has a foreign
 * key to another plugin's table (invariant 2): a deleted agent or connector
 * reaches these tables through cleanup.ts.
 */

export interface AppsBridgeLinkCodesTable {
  code_hash: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  agent_id: ColumnType<string, string, never>;
  expires_at: ColumnType<Date, Date, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface AppsBridgeLinksTable {
  platform_id: ColumnType<string, string, never>;
  app_id: ColumnType<string, string, never>;
  agent_id: ColumnType<string, string, never>;
  linked_by_user_id: ColumnType<string, string, never>;
  app_name: ColumnType<string, string, never>;
  link_code_hash: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface AppsBridgeGrantsTable {
  platform_id: ColumnType<string, string, never>;
  app_id: ColumnType<string, string, never>;
  connector_id: ColumnType<string, string, never>;
  mode: ColumnType<string, string, string>;
  tool_keys: ColumnType<string[], string[], string[]>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface AppsBridgeViewerApprovalsTable {
  viewer_user_id: ColumnType<string, string, never>;
  platform_id: ColumnType<string, string, never>;
  app_id: ColumnType<string, string, never>;
  connector_id: ColumnType<string, string, never>;
  agent_id: ColumnType<string, string, string>;
  tool_keys: ColumnType<string[], string[], string[]>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface AppsBridgeDatabase {
  apps_bridge_v1_link_codes: AppsBridgeLinkCodesTable;
  apps_bridge_v1_links: AppsBridgeLinksTable;
  apps_bridge_v1_grants: AppsBridgeGrantsTable;
  apps_bridge_v1_viewer_approvals: AppsBridgeViewerApprovalsTable;
}

/** Create the tables and indexes. Idempotent: it runs on every boot. */
export async function runAppsBridgeMigration(db: Kysely<AppsBridgeDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS apps_bridge_v1_link_codes (
      code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS apps_bridge_v1_link_codes_agent_idx ON apps_bridge_v1_link_codes (agent_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS apps_bridge_v1_link_codes_expiry_idx ON apps_bridge_v1_link_codes (expires_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS apps_bridge_v1_links (
      platform_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      linked_by_user_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      link_code_hash TEXT NOT NULL CHECK (link_code_hash ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (platform_id, app_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS apps_bridge_v1_links_agent_idx ON apps_bridge_v1_links (agent_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS apps_bridge_v1_grants (
      platform_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('builder', 'viewer')),
      tool_keys TEXT[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (platform_id, app_id, connector_id),
      FOREIGN KEY (platform_id, app_id) REFERENCES apps_bridge_v1_links (platform_id, app_id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS apps_bridge_v1_grants_connector_idx ON apps_bridge_v1_grants (connector_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS apps_bridge_v1_viewer_approvals (
      viewer_user_id TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_keys TEXT[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (viewer_user_id, platform_id, app_id, connector_id),
      FOREIGN KEY (platform_id, app_id, connector_id)
        REFERENCES apps_bridge_v1_grants (platform_id, app_id, connector_id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS apps_bridge_v1_viewer_approvals_agent_idx ON apps_bridge_v1_viewer_approvals (agent_id)`.execute(db);
}
