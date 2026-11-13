import { sql, type Kysely, type Selectable } from 'kysely';
import { cleanLabel } from './label.js';
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
  remove(installId: string): Promise<void>;
  /**
   * Delete every install, any status, in ONE statement, and return exactly
   * the rows that statement deleted, in no particular order. A row inserted
   * meanwhile is either deleted and returned or kept; a delete that fails
   * deletes and returns nothing.
   */
  removeAll(): Promise<RemovedInstall[]>;
}

const INSTALLS = 'channel_slack_v1_installs';

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
  readonly code: 'install-not-pending';
  constructor(code: 'install-not-pending') {
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

    async remove(installId) {
      await db.deleteFrom(INSTALLS).where('install_id', '=', installId).execute();
    },

    async removeAll() {
      const rows = await db
        .deleteFrom(INSTALLS)
        .returning(['install_id', 'app_id', 'team_id'])
        .execute();
      return rows.map((r) => ({ installId: r.install_id, appId: r.app_id, teamId: r.team_id }));
    },
  };
}
