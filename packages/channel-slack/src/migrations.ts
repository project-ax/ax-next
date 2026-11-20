import { sql, type ColumnType, type Kysely } from 'kysely';

/**
 * @ax/channel-slack owns the tables under the `channel_slack_v1_` prefix
 * (invariant 4: one source of truth). Nothing else reads or writes them, and
 * every query against them lives in store.ts or channel-store.ts.
 *
 *   channel_slack_v1_installs — one row per Slack app AX created: `pending`
 *     until its Allow, then `active`. `kind` says which app it is. `shared`
 *     is the one Admin › Slack connects: at most one per AX instance (admin
 *     operations run one at a time). `bot` is a team agent's own bot
 *     (TASK-1167): at most one per agent, pending included (a partial unique
 *     index). A bot row names its `agent_id`, the one agent its mentions run,
 *     and its `requested_by_user_id`, the team admin who asked for it, whom
 *     its channels' outsiders run as (each of its bindings copies it at the
 *     first mention there). `bot_handle` is the @handle Slack gave its bot
 *     user, read once at its Allow. The shared row has none of these three,
 *     and a CHECK pairs `agent_id` and `requested_by_user_id` with the kind,
 *     so neither kind can pass for the other.
 *     `connected_by_user_id` is whose configuration token made the app: the
 *     admin who connected the shared app, or a bot's approver (its requester
 *     on the self path, or the AX admin who approved its request, TASK-1169).
 *     Every change to the app uses that person's token
 *     (one per person, TASK-1175), and vault reads name them. Only the insert
 *     sets it: a Replace (TASK-1128) stores the pasted token as theirs and
 *     moves only `config_token_added_at`, when the token was last added.
 *     `created_at` is still when the row was made, and it orders `current()`.
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
 *   channel_slack_v1_threads — the memory switch's map (TASK-1094): every
 *     conversation a channel turn ran in, with the install, channel and agent
 *     it belongs to. Memory asks about a bare conversation id
 *     (`memory:pre-capture`), so this is how the capture veto
 *     (capture-veto.ts) knows a conversation is a Slack channel thread at
 *     all. `not_remembered` is set by any turn that starts while the
 *     channel's switch is off, and never cleared: memory leaves its cursor
 *     where a refusal stopped it, so a thread with a turn said while the
 *     switch was off must stay refused after it is turned back on.
 *     `external` marks the conversation outsiders' turns run in (the
 *     connector's, key suffix `:external`): memory never learns from it,
 *     whatever the switch says. A conversation's key fixes it, so it never
 *     changes. `speaker_names` (TASK-1146) keeps the names a member's turns
 *     in the thread were labelled with, their display name and Slack id, so
 *     the veto can hand them to memory's speaker rule: memory stores nothing
 *     said in a channel under the name of the person who said it. Each name
 *     once, oldest first by when it was last seen, the 16 most recent
 *     (channel-store.ts). An outsiders' thread keeps none.
 *
 *   channel_slack_v1_leftover_apps — Slack apps AX made and couldn't
 *     delete. Disconnect's (TASK-1132): the stored configuration token was
 *     dead or revoked, or Slack didn't answer; the install's row moves its
 *     app id, name and person here in the statement that deletes it
 *     (store.ts). Connect's own (TASK-1159): trying the pasted refresh token
 *     failed (Slack refused it, didn't answer, or answered something else),
 *     or storing failed before the pending row, and then Slack wouldn't
 *     delete the app Connect had just made; no install row ever held that
 *     one, so Connect writes it here directly, with the connecting admin as
 *     its person. (Once the pending row exists, Connect's undo moves it here
 *     the way Disconnect does.)
 *     Either way the id is never in both tables. The next Connect or Replace
 *     tries to delete each with its maker's token (admin-routes.ts); the
 *     Slack tab names them until that works or the admin says they deleted
 *     one by hand (`forget-leftover-app`). Keyed by the install's id (for
 *     Connect's own, the one it minted). No secret.
 *     `connected_by_user_id` (TASK-1175) is whose configuration token made
 *     the app (the removed install's person, or the admin whose Connect
 *     made it): on Slack, only that person's token can manage the app
 *     (design §8 Q5). NULL for an app left before the column, never
 *     backfilled.
 *
 *   channel_slack_v1_bot_requests — a team admin's open ask for their
 *     agent's own bot, waiting for an AX admin (TASK-1169): the agent, the
 *     team admin who asked (`requested_by_user_id`) and the bot's name. One
 *     per agent (a unique index). An AX admin's Approve turns it into a
 *     pending bot row in the installs table, with that admin as its
 *     `connected_by_user_id` and the asker as its `requested_by_user_id`,
 *     and deletes it. An AX admin's Decline, the team's Cancel, the agent's
 *     deletion (agents-deleted.ts) and a reset delete it too; nothing ever
 *     changes one. It names the person who asked and never an approver: no
 *     configuration token is involved until an AX admin approves, so
 *     `personHasApps` (store.ts) never reads it. No picture either: the
 *     approving admin's browser draws the deployment's logo at Approve, as
 *     Connect's does. Keyed by a random id of our own (`request_id`).
 *
 * No secret is here. They live in the credentials vault (secrets.ts): an
 * install's three under `slack:<install_id>:<name>`, and the configuration
 * refresh token once per person (TASK-1175), under
 * `slack:person:<connected_by_user_id>:config-refresh-token`, shared by every
 * app of theirs. Nor is any AX account's
 * name: `connected_by_user_id` is an id in the installs, channels and
 * leftover apps tables, as `requested_by_user_id` is in the installs and bot
 * requests tables, and that person's name is read from auth when it is
 * shown (invariant 4).
 * The one kind of person's name kept here is Slack's: `speaker_names` holds
 * members' Slack display names and ids as their sender labels showed them,
 * untrusted profile text for memory to compare against, never shown, logged
 * or used for identity. The OAuth `state` is kept only as
 * a sha256, beside the person it was minted for and its expiry, so it survives
 * a restart between Connect and Allow and can be spent exactly once, and only
 * by its own kind's callback (store.ts, TASK-1167).
 *
 * No foreign keys, between these tables or to any other plugin's: tests
 * TRUNCATE and DROP the installs table on its own, and an agent's row is the
 * agents plugin's (invariant 2). Cleanup is code instead: removing an install
 * deletes its bindings in the same statement (store.ts) but KEEPS its thread
 * rows, so a thread kept out of memory stays out after Slack is disconnected
 * (with no binding left, the veto refuses every thread it knows of that
 * channel). A deleted agent's bindings and threads go together when the
 * agents plugin announces the delete (agents-deleted.ts). The hook's name is
 * left unquoted here on purpose: the repo guard
 * (scripts/__tests__/agent-keyed-tables-are-cleaned.test.js) counts a quoted
 * one as the subscription, and a comment is not one.
 *
 * `status` has no CHECK on purpose: store.ts reads any value other than
 * `active` as `pending`, which fails closed (events are ignored). `kind` has
 * one, beside the CHECK that pairs it with the bot columns: an unknown kind
 * is refused outright, and store.ts still reads anything but `shared` as a
 * bot, the kind that can do less.
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
  config_token_added_at: ColumnType<Date, Date | undefined, Date>;
  installed_at: Date | null;
  oauth_state_hash: string | null;
  oauth_state_user_id: string | null;
  oauth_state_expires_at: Date | null;
  // TASK-1167. An install's kind and its bot's agent never change.
  kind: ColumnType<string, string, never>;
  agent_id: ColumnType<string | null, string | null, never>;
  requested_by_user_id: string | null;
  bot_handle: string | null;
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

export interface ChannelSlackThreadsTable {
  conversation_id: string;
  install_id: string;
  channel_id: string;
  agent_id: string;
  not_remembered: ColumnType<boolean, boolean | undefined, boolean>;
  external: ColumnType<boolean, boolean | undefined, boolean>;
  speaker_names: ColumnType<string[], string[] | undefined, string[]>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface ChannelSlackLeftoverAppsTable {
  install_id: string;
  app_id: string;
  bot_name: string;
  left_at: ColumnType<Date, Date | undefined, never>;
  connected_by_user_id: string | null;
}

/**
 * TASK-1169. A request is inserted and deleted, never updated, so an approve
 * keyed on its id takes exactly the request its admin saw.
 */
export interface ChannelSlackBotRequestsTable {
  request_id: ColumnType<string, string, never>;
  agent_id: ColumnType<string, string, never>;
  requested_by_user_id: ColumnType<string, string, never>;
  bot_name: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface ChannelSlackDatabase {
  channel_slack_v1_installs: ChannelSlackInstallsTable;
  channel_slack_v1_channels: ChannelSlackChannelsTable;
  channel_slack_v1_threads: ChannelSlackThreadsTable;
  channel_slack_v1_leftover_apps: ChannelSlackLeftoverAppsTable;
  channel_slack_v1_bot_requests: ChannelSlackBotRequestsTable;
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
  await sql`
    CREATE TABLE IF NOT EXISTS channel_slack_v1_threads (
      conversation_id        TEXT PRIMARY KEY,
      install_id             TEXT NOT NULL,
      channel_id             TEXT NOT NULL,
      agent_id               TEXT NOT NULL,
      not_remembered         BOOLEAN NOT NULL DEFAULT false,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  // A deleted agent's threads are removed by it.
  await sql`
    CREATE INDEX IF NOT EXISTS channel_slack_v1_threads_agent
      ON channel_slack_v1_threads (agent_id)
  `.execute(db);
  // Outsiders' threads are never remembered (capture-veto.ts). The default
  // fails closed: a row that doesn't say (one written before this column,
  // none of which exist in production) reads as an outsider's, and the veto
  // refuses memory for anything but `false`. recordThread, the only writer,
  // always names it.
  await sql`
    ALTER TABLE channel_slack_v1_threads
      ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT true
  `.execute(db);
  // The names a member's turns were labelled with (TASK-1146), for memory's
  // speaker rule. A row from before this column has none until its member's
  // next turn adds theirs (not backfilled: this plugin learns a member's
  // names only from users.info as their turn starts); until then memory
  // applies its `user` rule alone.
  await sql`
    ALTER TABLE channel_slack_v1_threads
      ADD COLUMN IF NOT EXISTS speaker_names TEXT[] NOT NULL DEFAULT '{}'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS channel_slack_v1_leftover_apps (
      install_id             TEXT PRIMARY KEY,
      app_id                 TEXT NOT NULL,
      bot_name               TEXT NOT NULL,
      left_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  // When the install's configuration token was added (TASK-1128): Connect's
  // INSERT sets it with created_at's own now(), and a Replace moves it. Four
  // steps, because a single `ADD COLUMN … NOT NULL DEFAULT now()` would stamp
  // every existing install with the migration's time, so "Added on" would show
  // the deploy date. An install from before the column takes its created_at,
  // the moment Connect added its token. The UPDATE fills only NULLs, so a
  // later boot never overwrites a replace.
  await sql`
    ALTER TABLE channel_slack_v1_installs
      ADD COLUMN IF NOT EXISTS config_token_added_at TIMESTAMPTZ NULL
  `.execute(db);
  await sql`
    ALTER TABLE channel_slack_v1_installs
      ALTER COLUMN config_token_added_at SET DEFAULT now()
  `.execute(db);
  await sql`
    UPDATE channel_slack_v1_installs
       SET config_token_added_at = created_at
     WHERE config_token_added_at IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE channel_slack_v1_installs
      ALTER COLUMN config_token_added_at SET NOT NULL
  `.execute(db);
  // Whose configuration token made a leftover app (TASK-1175), so it can be
  // deleted with that person's token. NULL means the app was left before
  // this column: never backfilled, because the install row that knew the
  // person is gone, and a guess would hand an unknown app to someone.
  await sql`
    ALTER TABLE channel_slack_v1_leftover_apps
      ADD COLUMN IF NOT EXISTS connected_by_user_id TEXT NULL
  `.execute(db);
  // A team agent's own bot (TASK-1167) is a second kind of install. Every
  // row from before is the shared app: the default says so, and none of them
  // has an agent, a requester or a handle.
  await sql`
    ALTER TABLE channel_slack_v1_installs
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shared' CHECK (kind IN ('shared', 'bot')),
      ADD COLUMN IF NOT EXISTS agent_id TEXT NULL,
      ADD COLUMN IF NOT EXISTS requested_by_user_id TEXT NULL,
      ADD COLUMN IF NOT EXISTS bot_handle TEXT NULL
  `.execute(db);
  // Fail closed in the database: a bot always names its agent and its
  // requester, and the shared app names neither, so a bot row can never lose
  // its agent and still be read. Added once, by name, by the recipe of
  // `conversations_v1_events_event_kind_check` (@ax/conversations): two
  // replicas booting at once (or the CLI reset's own process) take the
  // advisory lock in turn, and the second finds the constraint there. Every
  // row from before is `shared` with neither column, so the ADD's check of
  // them can't fail.
  await sql`
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('channel_slack_v1_installs_kind_fields'));
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'channel_slack_v1_installs'::regclass
           AND conname = 'channel_slack_v1_installs_kind_fields'
      ) THEN
        ALTER TABLE channel_slack_v1_installs
          ADD CONSTRAINT channel_slack_v1_installs_kind_fields CHECK (
            (kind = 'shared' AND agent_id IS NULL AND requested_by_user_id IS NULL)
            OR (kind = 'bot' AND agent_id IS NOT NULL AND requested_by_user_id IS NOT NULL)
          );
      END IF;
    END $$
  `.execute(db);
  // One bot per agent, pending or active: of two requests for one agent,
  // the database lets exactly one in (store.ts answers the other
  // `bot-exists`).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_slack_v1_installs_bot_agent
      ON channel_slack_v1_installs (agent_id)
      WHERE kind = 'bot'
  `.execute(db);
  // A team admin's ask for their agent's own bot, waiting for an AX admin
  // (TASK-1169).
  await sql`
    CREATE TABLE IF NOT EXISTS channel_slack_v1_bot_requests (
      request_id             TEXT PRIMARY KEY,
      agent_id               TEXT NOT NULL,
      requested_by_user_id   TEXT NOT NULL,
      bot_name               TEXT NOT NULL,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  // One open request per agent: of two asks for one agent, the database lets
  // exactly one in (store.ts answers the other `request-exists`).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_slack_v1_bot_requests_agent
      ON channel_slack_v1_bot_requests (agent_id)
  `.execute(db);
}
