import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/channel-slack owns the tables under the `channel_slack_v1_` prefix
 * (invariant 4: one source of truth). Nothing else reads or writes them, they
 * have no foreign keys, and every query against them lives in store.ts.
 *
 *   channel_slack_v1_installs — one row per Slack app AX created: `pending`
 *     from Connect until the admin clicks Allow, then `active`. At most one
 *     shared-app install per AX instance today (admin operations run one at a
 *     time); later cards add per-agent installs here.
 *
 * Its four secrets are NOT here: they live in the credentials vault under
 * `slack:<install_id>:<name>` (secrets.ts). Nor is the connecting admin's
 * name: `connected_by_user_id` is an id, and the name is read from auth when
 * it is shown (invariant 4). The OAuth `state` is kept only as
 * a sha256, beside the admin it was minted for and its expiry, so it survives
 * a restart between Connect and Allow and can be spent exactly once.
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

export interface ChannelSlackDatabase {
  channel_slack_v1_installs: ChannelSlackInstallsTable;
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
}
