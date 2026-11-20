import { sql, type Kysely, type Selectable } from 'kysely';
import { cleanLabel } from './label.js';
import { LEFTOVER_APPS_MAX } from './limits.js';
import type {
  ChannelSlackBotRequestsTable,
  ChannelSlackDatabase,
  ChannelSlackInstallsTable,
} from './migrations.js';

/**
 * Which Slack app an install is: `shared`, the one Admin › Slack connects, or
 * `bot`, a team agent's own bot (TASK-1167).
 */
export type InstallKind = 'shared' | 'bot';

/**
 * One Slack app AX created. Never carries its OAuth state or a secret: the
 * state stays inside this file, the secrets in the vault (secrets.ts).
 */
export interface InstallRow {
  installId: string;
  /**
   * Read as `shared` only when the column says exactly that. Anything else
   * reads as `bot`, the kind that can do less: it answers for one agent only.
   */
  kind: InstallKind;
  status: 'pending' | 'active';
  appId: string;
  clientId: string;
  botName: string;
  /** Null until the Allow. */
  teamId: string | null;
  teamName: string | null;
  botUserId: string | null;
  /**
   * Whose configuration token made the app: the admin who connected the
   * shared app, or a bot's approver (its requester on the self path, or the
   * AX admin who approved its request, TASK-1169). So every change to the
   * app uses their token (one per person, TASK-1175).
   * Vault reads name them. Set once, by the insert: a Replace stores the
   * pasted token as theirs and never moves the app to another person. Their
   * name is auth's, read when shown.
   */
  connectedByUserId: string;
  /** A bot's agent, the one team agent its mentions run. Null for the shared app. */
  agentId: string | null;
  /**
   * The team admin who asked for a bot, whom its channels' outsiders run as.
   * Each of its bindings copies it at the first mention there. Null for the
   * shared app.
   */
  requestedByUserId: string | null;
  /**
   * A live bot's @handle, as Slack named its bot user, read once at its
   * Allow. Null before that, when that read failed, and for the shared app.
   */
  botHandle: string | null;
  /** When the row was made, by Connect or a bot's request. Orders `current()` and `listBots()`. */
  createdAt: Date;
  /**
   * When the configuration token this install uses was added. At Connect
   * that is the same instant as `createdAt`; after a Replace it is the latest
   * replace (TASK-1128).
   */
  configTokenAddedAt: Date;
  installedAt: Date | null;
}

/**
 * What a reset needs about an install it deleted: the ids and the kind its
 * log line names, and the person whose configuration token the install used
 * (TASK-1175), which no log line carries. Never a secret or the client id.
 */
export type RemovedInstall = Pick<InstallRow, 'installId' | 'appId' | 'teamId' | 'connectedByUserId' | 'kind'>;

export interface OAuthState {
  installId: string;
  /** The admin it was minted for. */
  userId: string;
  expiresAt: Date;
}

/**
 * A Slack app AX made and couldn't delete (Disconnect's, or Connect's own
 * undo's), so it may still be on Slack. No secret.
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
  /**
   * Whose configuration token made the app (TASK-1175): the removed
   * install's person, or the admin whose Connect made it. On Slack, only
   * that person's token can manage it (design §8 Q5). Null for an app left
   * before TASK-1175. An id, never a name, and never logged.
   */
  connectedByUserId: string | null;
}

/**
 * A team admin's open ask for their agent's own bot, waiting for an AX admin
 * (TASK-1169). No secret, no Slack app and no picture: nothing exists on
 * Slack until an AX admin approves it. Never changed: approving, declining or
 * cancelling it deletes it.
 */
export interface BotRequest {
  /**
   * Our own random id (16 bytes, base64url: 22 characters): how logs name
   * the request, and what an AX admin's approve or decline names.
   */
  requestId: string;
  agentId: string;
  /**
   * The team admin who asked: the bot's `requestedByUserId` once it is
   * approved. An id, never a name, and never logged.
   */
  requestedByUserId: string;
  /** Already passed `checkBotName`. */
  botName: string;
  createdAt: Date;
}

export interface InstallStore {
  /**
   * The one shared-app install, any status: the oldest `shared` row, if
   * there are several. Never a team agent's bot (TASK-1167).
   */
  current(): Promise<InstallRow | null>;
  /** Any kind. */
  get(installId: string): Promise<InstallRow | null>;
  /**
   * Every install, any status: the most recently added configuration token
   * first (`config_token_added_at`), then by install id.
   * Any kind: a team bot's row names its approver.
   */
  list(): Promise<InstallRow[]>;
  /**
   * Whether any install (any status) or any leftover app still names this
   * person as its `connectedByUserId` (TASK-1175). One statement, so both
   * tables are read at one moment. A leftover from before TASK-1175 names
   * no one, and a channel binding's person never counts: a binding names
   * whom its outsiders run as, not whose token made an app.
   * Any kind: a team bot's row names its approver.
   */
  personHasApps(userId: string): Promise<boolean>;
  /** The shared app's row, pending until its Allow. */
  insertPending(
    r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId'>,
  ): Promise<void>;
  /**
   * A team agent's own bot (TASK-1167), pending until its approver's Allow.
   * `connectedByUserId` is the approver, whose configuration token made the
   * app. One bot per agent, pending or active: the database's unique index
   * decides, so of two inserts for one agent exactly one gets in, and the
   * other throws `bot-exists`. An install id already taken throws as
   * `insertPending` does.
   */
  insertPendingBot(
    r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId'> & {
      agentId: string;
      requestedByUserId: string;
    },
  ): Promise<void>;
  /** The agent's bot, any status, or null. Never the shared app. */
  botForAgent(agentId: string): Promise<InstallRow | null>;
  /** Every bot, any status, oldest first (by `created_at`, then install id). */
  listBots(): Promise<InstallRow[]>;
  /**
   * Record an ACTIVE bot's @handle: one UPDATE of that column, nothing else.
   * Throws `install-not-active` when the install is missing, still pending,
   * or the shared app. `handle` must already have passed the callback's
   * check; nothing is cleaned here.
   */
  setBotHandle(installId: string, handle: string): Promise<void>;
  /**
   * Open a team admin's ask for their agent's own bot (TASK-1169). One per
   * agent: the database's unique index decides, so of two inserts for one
   * agent exactly one gets in, and the other throws `request-exists`. A
   * request id already taken throws as `insertPending` does. `botName` must
   * already have passed `checkBotName`; nothing is cleaned here.
   */
  insertBotRequest(r: Pick<BotRequest, 'requestId' | 'agentId' | 'requestedByUserId' | 'botName'>): Promise<void>;
  /** One open request, by its id, or null. */
  getBotRequest(requestId: string): Promise<BotRequest | null>;
  /** The agent's open request, or null. */
  botRequestForAgent(agentId: string): Promise<BotRequest | null>;
  /**
   * Every open request, oldest first (by `created_at`, then request id).
   * Uncapped, unlike `leftoverApps`: an agent has one at most, and a name
   * check has to see every one. A caller that shows them caps the list
   * (BOT_REQUESTS_MAX).
   */
  listBotRequests(): Promise<BotRequest[]>;
  /** Delete one open request, by its id. True when a row went. */
  removeBotRequest(requestId: string): Promise<boolean>;
  /** Delete the agent's open request: the removed request's id, or null when it had none. */
  removeBotRequestForAgent(agentId: string): Promise<string | null>;
  /**
   * Replace a PENDING install's OAuth state, so any earlier one stops
   * matching. Throws when the install is missing or already active.
   */
  setOAuthState(
    installId: string,
    s: { stateHash: string; userId: string; expiresAt: Date },
  ): Promise<void>;
  /**
   * Read a state of this kind's install without spending it. Expiry is the
   * caller's to judge. Each kind's callback reads only its own (TASK-1167):
   * another kind's state reads as none.
   */
  peekOAuthState(stateHash: string, kind: InstallKind): Promise<OAuthState | null>;
  /**
   * Spend a state of this kind's install: one UPDATE that clears it and
   * returns what it held. Of any number of concurrent consumes, exactly one
   * gets it. Expiry is the caller's to judge. Another kind's state is
   * neither returned nor spent.
   */
  consumeOAuthState(stateHash: string, kind: InstallKind): Promise<OAuthState | null>;
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
   * Record when the configuration token an ACTIVE install uses was added (a
   * Replace, TASK-1128): one UPDATE of that column and nothing else, so the
   * install's person and the channel bindings (another table) stay as they
   * are. A Replace never moves an app to another person (TASK-1175): only
   * `insertPending` writes `connected_by_user_id`. Throws
   * `install-not-active` when the install is missing or still pending.
   */
  setConfigTokenAddedAt(installId: string, addedAt: Date): Promise<void>;
  /**
   * Delete the install and its channel bindings in ONE statement: both go,
   * or (when the install's delete fails or skips the row) neither does.
   * With `appLeft`, the install's Slack app is still on Slack (Disconnect,
   * or Connect's undo, couldn't delete it): its id, name and person move to the leftover list
   * in the same statement, so a later Connect can delete it.
   */
  remove(installId: string, o?: { appLeft?: boolean }): Promise<void>;
  /**
   * Delete every install, any status and any kind, their channel bindings
   * and every open bot request (TASK-1169), in ONE statement, and return
   * exactly the installs that statement deleted, in no particular order. A
   * row inserted meanwhile is either deleted and returned or kept; a delete
   * that fails deletes and returns nothing. A binding goes only with an
   * install this delete removed.
   * Bots and requests too: its one caller is the bootstrap reset, which also
   * wipes every credential and every agent (TASK-1167).
   */
  removeAll(): Promise<RemovedInstall[]>;
  /**
   * The Slack apps AX made and couldn't delete, oldest first (by when they
   * were left, then install id), at most LEFTOVER_APPS_MAX.
   */
  leftoverApps(): Promise<LeftoverApp[]>;
  /**
   * Remember a Slack app Connect made and couldn't take back (TASK-1159),
   * before any install row held it. `connectedByUserId` is the connecting admin,
   * whose token made it. An id already on the list keeps its first app, and
   * that app's person.
   */
  rememberLeftoverApp(
    app: Pick<LeftoverApp, 'installId' | 'appId' | 'botName'> & { connectedByUserId: string },
  ): Promise<void>;
  /** Forget one leftover app, by its removed install's id. A missing one is not an error. */
  forgetLeftoverApp(installId: string): Promise<void>;
}

const INSTALLS = 'channel_slack_v1_installs';
const LEFTOVER_APPS = 'channel_slack_v1_leftover_apps';
const BOT_REQUESTS = 'channel_slack_v1_bot_requests';
/** The partial unique index that allows one bot per agent (migrations.ts). */
const BOT_AGENT_INDEX = 'channel_slack_v1_installs_bot_agent';
/** The unique index that allows one open bot request per agent (migrations.ts). */
const BOT_REQUEST_AGENT_INDEX = 'channel_slack_v1_bot_requests_agent';

/** Every column but the OAuth state, which never leaves this file in a row. */
const ROW_COLUMNS = [
  'install_id',
  'kind',
  'status',
  'app_id',
  'client_id',
  'bot_name',
  'team_id',
  'team_name',
  'bot_user_id',
  'connected_by_user_id',
  'agent_id',
  'requested_by_user_id',
  'bot_handle',
  'created_at',
  'config_token_added_at',
  'installed_at',
] as const;

type SelectedRow = Pick<Selectable<ChannelSlackInstallsTable>, (typeof ROW_COLUMNS)[number]>;

/** Fails closed: only exactly `shared` is the shared app. */
function toKind(kind: string): InstallKind {
  return kind === 'shared' ? 'shared' : 'bot';
}

function toRow(r: SelectedRow): InstallRow {
  return {
    installId: r.install_id,
    kind: toKind(r.kind),
    // No CHECK on the column: anything but `active` fails closed.
    status: r.status === 'active' ? 'active' : 'pending',
    appId: r.app_id,
    clientId: r.client_id,
    botName: r.bot_name,
    teamId: r.team_id,
    teamName: r.team_name,
    botUserId: r.bot_user_id,
    connectedByUserId: r.connected_by_user_id,
    agentId: r.agent_id,
    requestedByUserId: r.requested_by_user_id,
    botHandle: r.bot_handle,
    createdAt: r.created_at,
    configTokenAddedAt: r.config_token_added_at,
    installedAt: r.installed_at,
  };
}

const REQUEST_COLUMNS = ['request_id', 'agent_id', 'requested_by_user_id', 'bot_name', 'created_at'] as const;

type SelectedRequest = Pick<Selectable<ChannelSlackBotRequestsTable>, (typeof REQUEST_COLUMNS)[number]>;

function toRequest(r: SelectedRequest): BotRequest {
  return {
    requestId: r.request_id,
    agentId: r.agent_id,
    requestedByUserId: r.requested_by_user_id,
    botName: r.bot_name,
    createdAt: r.created_at,
  };
}

/**
 * Postgres refusing a second row for one agent: a unique violation on this
 * index (one bot, or one open request, per agent), and no other.
 */
function isUniqueViolationOn(err: unknown, index: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === index;
}

/**
 * A store call that found nothing to change, or an agent that already has
 * its bot (`bot-exists`) or an open bot request (`request-exists`). Carries
 * no data, so it is safe to log.
 */
export class InstallStoreError extends Error {
  readonly code: 'install-not-pending' | 'install-not-active' | 'bot-exists' | 'request-exists';
  constructor(code: 'install-not-pending' | 'install-not-active' | 'bot-exists' | 'request-exists') {
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
        .where('kind', '=', 'shared')
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

    async list() {
      const rows = await db
        .selectFrom(INSTALLS)
        .select(ROW_COLUMNS)
        .orderBy('config_token_added_at', 'desc')
        .orderBy('install_id', 'asc')
        .execute();
      return rows.map(toRow);
    },

    async personHasApps(userId) {
      const r = await sql<{ named: boolean }>`
        SELECT EXISTS (SELECT 1 FROM channel_slack_v1_installs WHERE connected_by_user_id = ${userId})
            OR EXISTS (SELECT 1 FROM channel_slack_v1_leftover_apps WHERE connected_by_user_id = ${userId})
            AS named
      `.execute(db);
      return r.rows[0]?.named === true;
    },

    async insertPending(r) {
      await db
        .insertInto(INSTALLS)
        .values({
          install_id: r.installId,
          kind: 'shared',
          status: 'pending',
          app_id: r.appId,
          client_id: r.clientId,
          bot_name: r.botName,
          team_id: null,
          team_name: null,
          bot_user_id: null,
          connected_by_user_id: r.connectedByUserId,
          agent_id: null,
          requested_by_user_id: null,
          bot_handle: null,
          installed_at: null,
          oauth_state_hash: null,
          oauth_state_user_id: null,
          oauth_state_expires_at: null,
        })
        .execute();
    },

    async insertPendingBot(r) {
      try {
        await db
          .insertInto(INSTALLS)
          .values({
            install_id: r.installId,
            kind: 'bot',
            status: 'pending',
            app_id: r.appId,
            client_id: r.clientId,
            bot_name: r.botName,
            team_id: null,
            team_name: null,
            bot_user_id: null,
            connected_by_user_id: r.connectedByUserId,
            agent_id: r.agentId,
            requested_by_user_id: r.requestedByUserId,
            bot_handle: null,
            installed_at: null,
            oauth_state_hash: null,
            oauth_state_user_id: null,
            oauth_state_expires_at: null,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolationOn(err, BOT_AGENT_INDEX)) throw new InstallStoreError('bot-exists');
        throw err;
      }
    },

    async botForAgent(agentId) {
      // The unique index allows one at most.
      const row = await db
        .selectFrom(INSTALLS)
        .select(ROW_COLUMNS)
        .where('kind', '=', 'bot')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return row === undefined ? null : toRow(row);
    },

    async listBots() {
      const rows = await db
        .selectFrom(INSTALLS)
        .select(ROW_COLUMNS)
        .where('kind', '=', 'bot')
        .orderBy('created_at', 'asc')
        .orderBy('install_id', 'asc')
        .execute();
      return rows.map(toRow);
    },

    async setBotHandle(installId, handle) {
      const r = await db
        .updateTable(INSTALLS)
        .set({ bot_handle: handle })
        .where('install_id', '=', installId)
        .where('kind', '=', 'bot')
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (r.numUpdatedRows !== 1n) throw new InstallStoreError('install-not-active');
    },

    async insertBotRequest(r) {
      try {
        await db
          .insertInto(BOT_REQUESTS)
          .values({
            request_id: r.requestId,
            agent_id: r.agentId,
            requested_by_user_id: r.requestedByUserId,
            bot_name: r.botName,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolationOn(err, BOT_REQUEST_AGENT_INDEX)) throw new InstallStoreError('request-exists');
        throw err;
      }
    },

    async getBotRequest(requestId) {
      const row = await db
        .selectFrom(BOT_REQUESTS)
        .select(REQUEST_COLUMNS)
        .where('request_id', '=', requestId)
        .executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },

    async botRequestForAgent(agentId) {
      // The unique index allows one at most.
      const row = await db
        .selectFrom(BOT_REQUESTS)
        .select(REQUEST_COLUMNS)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },

    async listBotRequests() {
      const rows = await db
        .selectFrom(BOT_REQUESTS)
        .select(REQUEST_COLUMNS)
        .orderBy('created_at', 'asc')
        .orderBy('request_id', 'asc')
        .execute();
      return rows.map(toRequest);
    },

    async removeBotRequest(requestId) {
      const r = await db.deleteFrom(BOT_REQUESTS).where('request_id', '=', requestId).executeTakeFirst();
      return r.numDeletedRows > 0n;
    },

    async removeBotRequestForAgent(agentId) {
      const row = await db
        .deleteFrom(BOT_REQUESTS)
        .where('agent_id', '=', agentId)
        .returning('request_id')
        .executeTakeFirst();
      return row?.request_id ?? null;
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

    async peekOAuthState(stateHash, kind) {
      const row = await db
        .selectFrom(INSTALLS)
        .select(['install_id', 'oauth_state_user_id', 'oauth_state_expires_at'])
        .where('oauth_state_hash', '=', stateHash)
        .where('kind', '=', kind)
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

    async consumeOAuthState(stateHash, kind) {
      // RETURNING sees the row AFTER the update (state cleared), so the
      // values come from the pre-update copy in `old`. The outer
      // `i.oauth_state_hash = …` is what makes it single-use: a concurrent
      // consume blocks on the row lock, then re-checks that condition against
      // the committed row (NULL by then) and updates, and returns, nothing.
      // `old` holds only this kind's row, so another kind's state is never
      // cleared (an install's kind never changes).
      const r = await sql<{ install_id: string; user_id: string | null; expires_at: Date | null }>`
        UPDATE channel_slack_v1_installs AS i
           SET oauth_state_hash = NULL,
               oauth_state_user_id = NULL,
               oauth_state_expires_at = NULL
          FROM (SELECT install_id, oauth_state_user_id, oauth_state_expires_at
                  FROM channel_slack_v1_installs
                 WHERE oauth_state_hash = ${stateHash}
                   AND kind = ${kind}) AS old
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

    async setConfigTokenAddedAt(installId, addedAt) {
      const r = await db
        .updateTable(INSTALLS)
        .set({ config_token_added_at: addedAt })
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
    // keeps the install and its bindings. The person goes with it, read from
    // the row the delete removed (TASK-1175). `ON CONFLICT` keeps the first
    // app an id left, which only tests can hit (they re-use install ids).
    async remove(installId, o) {
      if (o?.appLeft === true) {
        await sql`
          WITH removed AS (
            DELETE FROM channel_slack_v1_installs
             WHERE install_id = ${installId}
            RETURNING install_id, app_id, bot_name, connected_by_user_id
          ), kept AS (
            INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name, connected_by_user_id)
            SELECT install_id, app_id, bot_name, connected_by_user_id FROM removed
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

    // Every open bot request goes in the same statement (TASK-1169): the
    // reset wipes every agent without announcing it, so a request it left
    // would name an agent that's gone.
    async removeAll() {
      const r = await sql<{
        install_id: string;
        app_id: string;
        team_id: string | null;
        connected_by_user_id: string;
        kind: string;
      }>`
        WITH removed AS (
          DELETE FROM channel_slack_v1_installs
          RETURNING install_id, app_id, team_id, connected_by_user_id, kind
        ), unbound AS (
          DELETE FROM channel_slack_v1_channels
           WHERE install_id IN (SELECT install_id FROM removed)
        ), requests AS (
          DELETE FROM channel_slack_v1_bot_requests
        )
        SELECT install_id, app_id, team_id, connected_by_user_id, kind FROM removed
      `.execute(db);
      return r.rows.map((row) => ({
        installId: row.install_id,
        appId: row.app_id,
        teamId: row.team_id,
        connectedByUserId: row.connected_by_user_id,
        kind: toKind(row.kind),
      }));
    },

    async leftoverApps() {
      const rows = await db
        .selectFrom(LEFTOVER_APPS)
        .select(['install_id', 'app_id', 'bot_name', 'left_at', 'connected_by_user_id'])
        .orderBy('left_at', 'asc')
        .orderBy('install_id', 'asc')
        .limit(LEFTOVER_APPS_MAX)
        .execute();
      return rows.map((r) => ({
        installId: r.install_id,
        appId: r.app_id,
        botName: r.bot_name,
        leftAt: r.left_at,
        connectedByUserId: r.connected_by_user_id,
      }));
    },

    async rememberLeftoverApp(app) {
      await sql`
        INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name, connected_by_user_id)
        VALUES (${app.installId}, ${app.appId}, ${app.botName}, ${app.connectedByUserId})
        ON CONFLICT (install_id) DO NOTHING
      `.execute(db);
    },

    async forgetLeftoverApp(installId) {
      await db.deleteFrom(LEFTOVER_APPS).where('install_id', '=', installId).execute();
    },
  };
}
