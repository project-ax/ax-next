import { sql, type Kysely, type Selectable } from 'kysely';
import { cleanLabel } from './label.js';
import { LEFTOVER_APPS_MAX } from './limits.js';
import type { ChannelSlackDatabase, ChannelSlackInstallsTable } from './migrations.js';

/**
 * One Slack app AX created. Never carries its OAuth state or a secret: the
 * state stays inside this file, the secrets in the vault (secrets.ts).
 */
export interface InstallRow {
  installId: string;
  status: 'pending' | 'active';
  appId: string;
  clientId: string;
  botName: string;
  /** Null until the admin clicks Allow. */
  teamId: string | null;
  teamName: string | null;
  botUserId: string | null;
  /** The admin who pasted the configuration token. Their name is auth's, read when shown. */
  connectedByUserId: string;
  createdAt: Date;
  installedAt: Date | null;
}

/** What a reset needs to say about an install it deleted. Never a secret or the client id. */
export type RemovedInstall = Pick<InstallRow, 'installId' | 'appId' | 'teamId'>;

export interface OAuthState {
  installId: string;
  /** The admin it was minted for. */
  userId: string;
  expiresAt: Date;
}

/**
 * A Slack app AX made and couldn't delete (Disconnect's, or Connect's own after Slack
 * refused the pasted refresh token), so it may still be on Slack. No secret.
 */
export interface LeftoverApp {
  /**
   * The install's id (a removed install's, or the one Connect minted and never
   * stored): how logs name it, and the key to forget it by.
   */
  installId: string;
  appId: string;
  botName: string;
  leftAt: Date;
}

export interface InstallStore {
  /** The one shared-app install, any status: the oldest row, if there are several. */
  current(): Promise<InstallRow | null>;
  get(installId: string): Promise<InstallRow | null>;
  insertPending(
    r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId'>,
  ): Promise<void>;
  /**
   * Replace a PENDING install's OAuth state, so any earlier one stops
   * matching. Throws when the install is missing or already active.
   */
  setOAuthState(
    installId: string,
    s: { stateHash: string; userId: string; expiresAt: Date },
  ): Promise<void>;
  /** Read a state without spending it. Expiry is the caller's to judge. */
  peekOAuthState(stateHash: string): Promise<OAuthState | null>;
  /**
   * Spend a state: one UPDATE that clears it and returns what it held. Of any
   * number of concurrent consumes, exactly one gets it. Expiry is the caller's
   * to judge.
   */
  consumeOAuthState(stateHash: string): Promise<OAuthState | null>;
  /** `pending` → `active`. Throws when the install is missing or not pending. */
  activate(
    installId: string,
    a: { teamId: string; teamName: string; botUserId: string; installedAt: Date },
  ): Promise<void>;
  /**
   * Rename an ACTIVE install: one UPDATE, nothing else touched. Throws
   * `install-not-active` when the install is missing or still pending.
   * `botName` must already have passed `checkBotName`; nothing is cleaned here.
   */
  setBotName(installId: string, botName: string): Promise<void>;
  /**
   * Delete the install and its channel bindings in ONE statement: both go,
   * or (when the install's delete fails or skips the row) neither does.
   * With `appLeft`, the install's Slack app is still on Slack (Disconnect
   * couldn't delete it): its id and name move to the leftover list in the
   * same statement, so a later Connect can delete it.
   */
  remove(installId: string, o?: { appLeft?: boolean }): Promise<void>;
  /**
   * Delete every install, any status, and their channel bindings, in ONE
   * statement, and return exactly the installs that statement deleted, in no
   * particular order. A row inserted meanwhile is either deleted and returned
   * or kept; a delete that fails deletes and returns nothing. A binding goes
   * only with an install this delete removed.
   */
  removeAll(): Promise<RemovedInstall[]>;
  /**
   * The Slack apps AX made and couldn't delete, oldest first (by when they
   * were left, then install id), at most LEFTOVER_APPS_MAX.
   */
  leftoverApps(): Promise<LeftoverApp[]>;
  /**
   * Remember a Slack app Connect made and couldn't take back (TASK-1159): no
   * install row ever held it. An id already on the list keeps its first app.
   */
  rememberLeftoverApp(app: Pick<LeftoverApp, 'installId' | 'appId' | 'botName'>): Promise<void>;
  /** Forget one leftover app, by its removed install's id. A missing one is not an error. */
  forgetLeftoverApp(installId: string): Promise<void>;
}

const INSTALLS = 'channel_slack_v1_installs';
const LEFTOVER_APPS = 'channel_slack_v1_leftover_apps';

/** Every column but the OAuth state, which never leaves this file in a row. */
const ROW_COLUMNS = [
  'install_id',
  'status',
  'app_id',
  'client_id',
  'bot_name',
  'team_id',
  'team_name',
  'bot_user_id',
  'connected_by_user_id',
  'created_at',
  'installed_at',
] as const;

type SelectedRow = Pick<Selectable<ChannelSlackInstallsTable>, (typeof ROW_COLUMNS)[number]>;

function toRow(r: SelectedRow): InstallRow {
  return {
    installId: r.install_id,
    // No CHECK on the column: anything but `active` fails closed.
    status: r.status === 'active' ? 'active' : 'pending',
    appId: r.app_id,
    clientId: r.client_id,
    botName: r.bot_name,
    teamId: r.team_id,
    teamName: r.team_name,
    botUserId: r.bot_user_id,
    connectedByUserId: r.connected_by_user_id,
    createdAt: r.created_at,
    installedAt: r.installed_at,
  };
}

/** A store call that found nothing to change. Carries no data, so it is safe to log. */
export class InstallStoreError extends Error {
  readonly code: 'install-not-pending' | 'install-not-active';
  constructor(code: 'install-not-pending' | 'install-not-active') {
    super(`channel-slack install store: ${code}`);
    this.name = 'InstallStoreError';
    this.code = code;
  }
}

export function createInstallStore(db: Kysely<ChannelSlackDatabase>): InstallStore {
  return {
    async current() {
      const row = await db
        .selectFrom(INSTALLS)
        .select(ROW_COLUMNS)
        .orderBy('created_at', 'asc')
        .orderBy('install_id', 'asc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : toRow(row);
    },

    async get(installId) {
      const row = await db
        .selectFrom(INSTALLS)
        .select(ROW_COLUMNS)
        .where('install_id', '=', installId)
        .executeTakeFirst();
      return row === undefined ? null : toRow(row);
    },

    async insertPending(r) {
      await db
        .insertInto(INSTALLS)
        .values({
          install_id: r.installId,
          status: 'pending',
          app_id: r.appId,
          client_id: r.clientId,
          bot_name: r.botName,
          team_id: null,
          team_name: null,
          bot_user_id: null,
          connected_by_user_id: r.connectedByUserId,
          installed_at: null,
          oauth_state_hash: null,
          oauth_state_user_id: null,
          oauth_state_expires_at: null,
        })
        .execute();
    },

    async setOAuthState(installId, s) {
      const r = await db
        .updateTable(INSTALLS)
        .set({
          oauth_state_hash: s.stateHash,
          oauth_state_user_id: s.userId,
          oauth_state_expires_at: s.expiresAt,
        })
        .where('install_id', '=', installId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (r.numUpdatedRows !== 1n) throw new InstallStoreError('install-not-pending');
    },

    async peekOAuthState(stateHash) {
      const row = await db
        .selectFrom(INSTALLS)
        .select(['install_id', 'oauth_state_user_id', 'oauth_state_expires_at'])
        .where('oauth_state_hash', '=', stateHash)
        .executeTakeFirst();
      if (
        row === undefined ||
        row.oauth_state_user_id === null ||
        row.oauth_state_expires_at === null
      ) {
        return null;
      }
      return {
        installId: row.install_id,
        userId: row.oauth_state_user_id,
        expiresAt: row.oauth_state_expires_at,
      };
    },

    async consumeOAuthState(stateHash) {
      // RETURNING sees the row AFTER the update (state cleared), so the
      // values come from the pre-update copy in `old`. The outer
      // `i.oauth_state_hash = …` is what makes it single-use: a concurrent
      // consume blocks on the row lock, then re-checks that condition against
      // the committed row (NULL by then) and updates, and returns, nothing.
      const r = await sql<{ install_id: string; user_id: string | null; expires_at: Date | null }>`
        UPDATE channel_slack_v1_installs AS i
           SET oauth_state_hash = NULL,
               oauth_state_user_id = NULL,
               oauth_state_expires_at = NULL
          FROM (SELECT install_id, oauth_state_user_id, oauth_state_expires_at
                  FROM channel_slack_v1_installs
                 WHERE oauth_state_hash = ${stateHash}) AS old
         WHERE i.install_id = old.install_id
           AND i.oauth_state_hash = ${stateHash}
        RETURNING old.install_id AS install_id,
                  old.oauth_state_user_id AS user_id,
                  old.oauth_state_expires_at AS expires_at
      `.execute(db);
      const row = r.rows[0];
      if (row === undefined || row.user_id === null || row.expires_at === null) return null;
      return { installId: row.install_id, userId: row.user_id, expiresAt: row.expires_at };
    },

    async activate(installId, a) {
      const r = await db
        .updateTable(INSTALLS)
        .set({
          status: 'active',
          team_id: a.teamId,
          team_name: cleanLabel(a.teamName),
          bot_user_id: a.botUserId,
          installed_at: a.installedAt,
        })
        .where('install_id', '=', installId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (r.numUpdatedRows !== 1n) throw new InstallStoreError('install-not-pending');
    },

    async setBotName(installId, botName) {
      const r = await db
        .updateTable(INSTALLS)
        .set({ bot_name: botName })
        .where('install_id', '=', installId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (r.numUpdatedRows !== 1n) throw new InstallStoreError('install-not-active');
    },

    // Bindings go in the same statement as their install, keyed on what the
    // install delete RETURNED (data-modifying CTEs share one snapshot and
    // see each other only through RETURNING): a delete that fails rolls the
    // whole statement back, and one that skips an install keeps its bindings.
    // channel-store.ts owns every other query against the bindings.
    //
    // With `appLeft`, the app moves to the leftover list from that same
    // RETURNING (Postgres runs a data-modifying CTE to completion even though
    // nothing reads it): it is never in both tables, and an insert that fails
    // keeps the install and its bindings. `ON CONFLICT` keeps the first app
    // an id left, which only tests can hit (they re-use install ids).
    async remove(installId, o) {
      if (o?.appLeft === true) {
        await sql`
          WITH removed AS (
            DELETE FROM channel_slack_v1_installs
             WHERE install_id = ${installId}
            RETURNING install_id, app_id, bot_name
          ), kept AS (
            INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name)
            SELECT install_id, app_id, bot_name FROM removed
            ON CONFLICT (install_id) DO NOTHING
          )
          DELETE FROM channel_slack_v1_channels
           WHERE install_id IN (SELECT install_id FROM removed)
        `.execute(db);
        return;
      }
      await sql`
        WITH removed AS (
          DELETE FROM channel_slack_v1_installs
           WHERE install_id = ${installId}
          RETURNING install_id
        )
        DELETE FROM channel_slack_v1_channels
         WHERE install_id IN (SELECT install_id FROM removed)
      `.execute(db);
    },

    async removeAll() {
      const r = await sql<{ install_id: string; app_id: string; team_id: string | null }>`
        WITH removed AS (
          DELETE FROM channel_slack_v1_installs
          RETURNING install_id, app_id, team_id
        ), unbound AS (
          DELETE FROM channel_slack_v1_channels
           WHERE install_id IN (SELECT install_id FROM removed)
        )
        SELECT install_id, app_id, team_id FROM removed
      `.execute(db);
      return r.rows.map((row) => ({ installId: row.install_id, appId: row.app_id, teamId: row.team_id }));
    },

    async leftoverApps() {
      const rows = await db
        .selectFrom(LEFTOVER_APPS)
        .select(['install_id', 'app_id', 'bot_name', 'left_at'])
        .orderBy('left_at', 'asc')
        .orderBy('install_id', 'asc')
        .limit(LEFTOVER_APPS_MAX)
        .execute();
      return rows.map((r) => ({
        installId: r.install_id,
        appId: r.app_id,
        botName: r.bot_name,
        leftAt: r.left_at,
      }));
    },

    async rememberLeftoverApp(app) {
      await sql`
        INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name)
        VALUES (${app.installId}, ${app.appId}, ${app.botName})
        ON CONFLICT (install_id) DO NOTHING
      `.execute(db);
    },

    async forgetLeftoverApp(installId) {
      await db.deleteFrom(LEFTOVER_APPS).where('install_id', '=', installId).execute();
    },
  };
}
