import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/channel-slack owns the tables under the `channel_slack_v1_` prefix
 * (invariant 4: one source of truth). Nothing else reads or writes them, and
 * every query against them lives in store.ts or channel-store.ts.
 *
 *   channel_slack_v1_installs — one row per Slack app AX created: `pending`
 *     from Connect until the admin clicks Allow, then `active`. At most one
 *     shared-app install per AX instance today (admin operations run one at a
 *     time); later cards add per-agent installs here.
 *
 *   channel_slack_v1_channels — the bindings (TASK-1094): which team agent a
 *     public channel of an install is connected to. The primary key makes it
 *     one agent per channel; an agent may have several channels.
 *     `connected_by_user_id` is the team admin who connected it, the person a
 *     channel's outsiders run as, so every write names the binding's agent and
 *     another agent can neither take the channel nor change it
 *     (channel-store.ts). `remember` is the channel's memory switch.
 *     `channel_name` is Slack's, cleaned (label.ts) and read once per connect:
 *     a rename shows on the next connect.
 *
 * The install's four secrets are NOT here: they live in the credentials vault
 * under `slack:<install_id>:<name>` (secrets.ts). Nor is anyone's name:
 * `connected_by_user_id` is an id in both tables, and the name is read from
 * auth when it is shown (invariant 4). The OAuth `state` is kept only as
 * a sha256, beside the admin it was minted for and its expiry, so it survives
 * a restart between Connect and Allow and can be spent exactly once.
 *
 * No foreign keys, between these tables or to any other plugin's: tests
 * TRUNCATE and DROP the installs table on its own, and an agent's row is the
 * agents plugin's (invariant 2). Cleanup is code instead: removing an install
 * deletes its bindings in the same statement (store.ts), and a deleted agent's
 * go when the agents plugin announces the delete (agents-deleted.ts). The
 * hook's name is left unquoted here on purpose: the repo guard
 * (scripts/__tests__/agent-keyed-tables-are-cleaned.test.js) counts a quoted
 * one as the subscription, and a comment is not one.
 *
 * `status` has no CHECK on purpose: store.ts reads any value other than
 * `active` as `pending`, which fails closed (events are ignored).
 *
 * Additive-only and idempotent: every boot runs it.
 */
export interface ChannelSlackInstallsTable {
  install_id: string;
  status: string;
  app_id: string;
  client_id: string;
  bot_name: string;
  team_id: string | null;
  team_name: string | null;
  bot_user_id: string | null;
  connected_by_user_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
  installed_at: Date | null;
  oauth_state_hash: string | null;
  oauth_state_user_id: string | null;
  oauth_state_expires_at: Date | null;
}

export interface ChannelSlackChannelsTable {
  install_id: string;
  channel_id: string;
  agent_id: string;
  connected_by_user_id: string;
  channel_name: string;
  remember: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ChannelSlackDatabase {
  channel_slack_v1_installs: ChannelSlackInstallsTable;
  channel_slack_v1_channels: ChannelSlackChannelsTable;
}

export async function runMigrations<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS channel_slack_v1_installs (
      install_id             TEXT PRIMARY KEY,
      status                 TEXT NOT NULL,
      app_id                 TEXT NOT NULL,
      client_id              TEXT NOT NULL,
      bot_name               TEXT NOT NULL,
      team_id                TEXT NULL,
      team_name              TEXT NULL,
      bot_user_id            TEXT NULL,
      connected_by_user_id   TEXT NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      installed_at           TIMESTAMPTZ NULL,
      oauth_state_hash       TEXT NULL,
      oauth_state_user_id    TEXT NULL,
      oauth_state_expires_at TIMESTAMPTZ NULL
    )
  `.execute(db);
  // A state names one install: the same hash on two rows would let one Allow
  // complete the other's install.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_slack_v1_installs_oauth_state_hash
      ON channel_slack_v1_installs (oauth_state_hash)
      WHERE oauth_state_hash IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS channel_slack_v1_channels (
      install_id             TEXT NOT NULL,
      channel_id             TEXT NOT NULL,
      agent_id               TEXT NOT NULL,
      connected_by_user_id   TEXT NOT NULL,
      channel_name           TEXT NOT NULL,
      remember               BOOLEAN NOT NULL DEFAULT true,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (install_id, channel_id)
    )
  `.execute(db);
  // An agent's settings list its channels, and a deleted agent's are removed by it.
  await sql`
    CREATE INDEX IF NOT EXISTS channel_slack_v1_channels_agent
      ON channel_slack_v1_channels (agent_id)
  `.execute(db);
}
