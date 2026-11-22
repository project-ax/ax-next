import { sql, type Kysely, type Selectable } from 'kysely';
import { cleanChannelName } from './label.js';
import { THREAD_SPEAKER_NAMES_MAX } from './limits.js';
import type { ChannelSlackChannelsTable, ChannelSlackDatabase } from './migrations.js';

/**
 * Which team agent a Slack channel is connected to (TASK-1094): one agent per
 * channel, any number of channels per agent.
 *
 * A binding decides whose identity the channel's outsiders run as (the bot's
 * requester, copied into the binding at its first mention; a Claim moves
 * it), so every write here is scoped to the agent the caller named, the one
 * it checked rights on: a second agent never takes a channel over (`upsert`
 * answers `taken`), and `remove` with another agent's id changes nothing.
 * Who may bind a channel is the caller's to decide (channels.ts), never this
 * file's. A binding says nothing about the channel's privacy: a private
 * channel is remembered like any other (TASK-1203, design §4c). It does
 * keep whether its channel has been told that, once (`claimNotice`).
 *
 * Removing an install removes its bindings in the same statement (store.ts);
 * `removeForAgent` is the agents:deleted cleanup (agents-deleted.ts).
 *
 * It also keeps the thread map (TASK-1094): which conversations are channel
 * threads, of which channel and agent, whether outsiders' turns run in it,
 * and whether one was marked not remembered before TASK-1203 (a turn while
 * its channel was private, TASK-1188, or switched off, TASK-1202); and, for
 * a member's thread, the names their turns were labelled with (TASK-1146).
 * The capture veto (capture-veto.ts) reads it; the router writes it when a
 * channel turn starts. Only `removeForAgent` deletes a thread row: an
 * install's removal and a disconnect keep them, so a marked thread stays
 * out of memory after Slack is gone.
 */
export interface ChannelBinding {
  installId: string;
  channelId: string;
  agentId: string;
  /**
   * Whom the channel's outsiders run as: the bot's requester, copied into the
   * binding at its first mention there; a Claim moves it (TASK-1173).
   */
  connectedByUserId: string;
  /** Slack's name for the channel when it was connected, cleaned (label.ts). */
  channelName: string;
  createdAt: Date;
}

/**
 * A conversation a channel turn ran in (TASK-1094). Written by the router
 * before the turn's agent runs; read by the capture veto.
 */
export interface ChannelThread {
  installId: string;
  channelId: string;
  agentId: string;
  /**
   * True for a thread marked before TASK-1203: a turn (or an Allow's
   * continuation) ran in it while its channel was private (TASK-1188), or
   * switched off (TASK-1202). Nothing sets it any more, and nothing ever
   * clears it: memory leaves its cursor where a refusal stopped it, so a
   * marked thread let in would have its next pass read the turns said under
   * "this isn't remembered".
   */
  notRemembered: boolean;
  /**
   * The conversation outsiders' (external) turns run in: memory never learns
   * from it. Fixed by the conversation's key.
   */
  external: boolean;
  /**
   * The names member turns here were labelled with (TASK-1146): each turn's
   * display name and Slack id (format.ts `senderLabelNames`). Each once,
   * oldest first by when it was last seen, at most THREAD_SPEAKER_NAMES_MAX
   * (the most recently seen). The capture veto hands them to memory, which
   * files a subject made of them under the member's own AX key on a team
   * agent (TASK-1204), and never under the name itself. Empty for an
   * outsiders' thread, and for a row from before TASK-1146 until its next
   * member turn. Slack's untrusted profile text: compared, never shown,
   * logged or used for identity.
   */
  speakerNames: string[];
}

/**
 * Whose turn is starting, as the router decided it: a member's, run as
 * themselves (`attended`), with the names their sender label shows
 * (`speakerNames`); or an outsider's, run as the binding's connector (the
 * bot's requester) when it was planned (`external`, `runAs`), which brings
 * no names.
 */
export type ThreadTurn = { mode: 'attended'; speakerNames: readonly string[] } | { mode: 'external'; runAs: string };

export interface ChannelStore {
  get(installId: string, channelId: string): Promise<ChannelBinding | null>;
  /** This agent's channels on this install, oldest first. */
  listForAgent(installId: string, agentId: string): Promise<ChannelBinding[]>;
  /**
   * Connect a channel, in ONE statement, so of any number of concurrent
   * connects exactly one can bind a free channel. `connected`: a new binding.
   * `reconnected`: the channel was already this agent's; the connector and
   * name are replaced, and createdAt kept, and so is a memory notice claim
   * (`claimNotice`): the channel was told already. `taken`: it is another
   * agent's, and nothing changed. The name is stored cleaned. A team agent's
   * own bot binds a channel with this at its first mention there (router.ts
   * `bindBotChannel`).
   */
  upsert(
    b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'>,
  ): Promise<'connected' | 'reconnected' | 'taken'>;
  /** Disconnect a channel from THIS agent. False when it isn't this agent's (or isn't bound at all). */
  remove(installId: string, channelId: string, agentId: string): Promise<boolean>;
  /**
   * Claim the memory notice of THIS agent's binding of the channel (TASK-1203,
   * design §4c: the post telling the channel what the bot hears there is
   * shared with anyone who talks to it), in ONE conditional statement, so of
   * any number of
   * claims at once, on any replica, exactly one wins. That one gets the
   * claim's stamp (opaque: hand it back to `releaseNotice` as is), and posts
   * the notice. Null when the notice was claimed before, or the channel
   * isn't this agent's (any more), or isn't bound at all; nothing changed. A
   * binding removed and made again is new, and claims again.
   */
  claimNotice(installId: string, channelId: string, agentId: string): Promise<string | null>;
  /**
   * Give a claim back when Slack refused the notice, so the channel's next
   * turn claims and posts it again. Only the claim `claimed` names (what
   * `claimNotice` answered), of THIS agent's binding of the channel: a
   * binding removed and made again while a post was failing has its own
   * claim, and keeps it. Anything else changes nothing.
   */
  releaseNotice(installId: string, channelId: string, agentId: string, claimed: string): Promise<void>;
  /**
   * Delete the agent's bindings and thread rows on every install, in one
   * transaction (both go, or neither does), and say how many of each went.
   */
  removeForAgent(agentId: string): Promise<{ channels: number; threads: number }>;
  /**
   * Record that a turn is starting in this conversation, in ONE statement
   * that reads the binding as it writes. A conversation's install, channel
   * and agent are written the first time and never change (its key names
   * them). A new thread is recorded remembered, whatever the channel's
   * privacy (TASK-1203, design §4c); a thread marked before keeps its mark
   * (`notRemembered`): nothing here clears it. `external` is the turn's mode
   * (anything but `attended` counts as external), and sticky: once true, it
   * stays true.
   * `no-binding`: the channel isn't this agent's (any more), nothing was
   * written, and the turn must not run. `reconnected`: an outsider's turn,
   * but the channel is connected by someone other than `runAs` now; nothing
   * was written, and the turn must not run (it was planned as `runAs`, in
   * their conversation). A member's turn doesn't depend on who connected.
   * A member's turn adds its names to the thread's in the same statement
   * (TASK-1146): the union, each once, ordered by when last seen, keeping
   * the THREAD_SPEAKER_NAMES_MAX most recent. An outsider's turn adds none,
   * whatever it is handed. Names arrive only with an attended turn.
   */
  recordThread(
    t: Omit<ChannelThread, 'notRemembered' | 'external' | 'speakerNames'> & {
      conversationId: string;
    } & ThreadTurn,
  ): Promise<'recorded' | 'no-binding' | 'reconnected'>;
  /** The thread a conversation is, or null when no channel turn ever ran in it (a web chat, a DM). */
  getThread(conversationId: string): Promise<ChannelThread | null>;
}

const CHANNELS = 'channel_slack_v1_channels';
const THREADS = 'channel_slack_v1_threads';

const COLUMNS = ['install_id', 'channel_id', 'agent_id', 'connected_by_user_id', 'channel_name', 'created_at'] as const;

type SelectedRow = Pick<Selectable<ChannelSlackChannelsTable>, (typeof COLUMNS)[number]>;

/**
 * `names` each once, in the order each was last seen, keeping the
 * THREAD_SPEAKER_NAMES_MAX seen most recently: what recordThread's conflict
 * does to a thread's union, done to one turn's own names before they're
 * written, so a new row holds no more than an old one could.
 */
function mostRecentNames(names: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = names.length - 1; i >= 0 && kept.length < THREAD_SPEAKER_NAMES_MAX; i -= 1) {
    const name = names[i]!;
    if (!kept.includes(name)) kept.push(name);
  }
  return kept.reverse();
}

function toBinding(r: SelectedRow): ChannelBinding {
  return {
    installId: r.install_id,
    channelId: r.channel_id,
    agentId: r.agent_id,
    connectedByUserId: r.connected_by_user_id,
    channelName: r.channel_name,
    createdAt: r.created_at,
  };
}

/**
 * A notice claim's stamp: `notice_posted_at` as UTC text to the microsecond,
 * the same whatever the session's DateStyle or TimeZone.
 */
const NOTICE_STAMP = sql<string>`to_char(notice_posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

export function createChannelStore(db: Kysely<ChannelSlackDatabase>): ChannelStore {
  return {
    async get(installId, channelId) {
      const row = await db
        .selectFrom(CHANNELS)
        .select(COLUMNS)
        .where('install_id', '=', installId)
        .where('channel_id', '=', channelId)
        .executeTakeFirst();
      return row === undefined ? null : toBinding(row);
    },

    async listForAgent(installId, agentId) {
      const rows = await db
        .selectFrom(CHANNELS)
        .select(COLUMNS)
        .where('install_id', '=', installId)
        .where('agent_id', '=', agentId)
        .orderBy('created_at', 'asc')
        .orderBy('channel_id', 'asc')
        .execute();
      return rows.map(toBinding);
    },

    async upsert(b) {
      // The conflict's UPDATE runs only when the row is already this agent's
      // (its WHERE), so another agent's connect returns no row and changes
      // nothing. A concurrent insert of the same channel waits on the primary
      // key, then takes that same conflict path: one statement, no
      // read-then-write window. `xmax = 0` holds only for a freshly inserted
      // row, so it tells a new binding from a reconnect. The conflict's SET
      // names neither `created_at` nor `notice_posted_at`: a reconnect keeps
      // both, so a channel told already isn't told again.
      const r = await sql<{ inserted: boolean }>`
        INSERT INTO channel_slack_v1_channels
          (install_id, channel_id, agent_id, connected_by_user_id, channel_name)
        VALUES
          (${b.installId}, ${b.channelId}, ${b.agentId}, ${b.connectedByUserId}, ${cleanChannelName(b.channelName)})
        ON CONFLICT (install_id, channel_id) DO UPDATE
           SET connected_by_user_id = EXCLUDED.connected_by_user_id,
               channel_name = EXCLUDED.channel_name,
               updated_at = now()
         WHERE channel_slack_v1_channels.agent_id = EXCLUDED.agent_id
        RETURNING (xmax = 0) AS inserted
      `.execute(db);
      const row = r.rows[0];
      if (row === undefined) return 'taken';
      return row.inserted ? 'connected' : 'reconnected';
    },

    async remove(installId, channelId, agentId) {
      const r = await db
        .deleteFrom(CHANNELS)
        .where('install_id', '=', installId)
        .where('channel_id', '=', channelId)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return r.numDeletedRows > 0n;
    },

    async claimNotice(installId, channelId, agentId) {
      // Of two claims at once, the second waits on the first's row lock, then
      // Postgres checks its WHERE again against the row the first wrote
      // (READ COMMITTED): it finds the notice claimed and updates nothing.
      // The stamp comes back as fixed UTC text with microseconds
      // (NOTICE_STAMP), so the release can name it exactly: a JS Date would
      // drop the microseconds and never match, and `::text` would depend on
      // the session's DateStyle and TimeZone (review round 2).
      const r = await db
        .updateTable(CHANNELS)
        .set({ notice_posted_at: sql<Date>`now()` })
        .where('install_id', '=', installId)
        .where('channel_id', '=', channelId)
        .where('agent_id', '=', agentId)
        .where('notice_posted_at', 'is', null)
        .returning(sql<string>`${NOTICE_STAMP}`.as('claimed'))
        .executeTakeFirst();
      return r?.claimed ?? null;
    },

    async releaseNotice(installId, channelId, agentId, claimed) {
      // Only this claim: a binding removed and made again meanwhile has its own stamp.
      await db
        .updateTable(CHANNELS)
        .set({ notice_posted_at: null })
        .where('install_id', '=', installId)
        .where('channel_id', '=', channelId)
        .where('agent_id', '=', agentId)
        .where(sql<boolean>`${NOTICE_STAMP} = ${claimed}`)
        .execute();
    },

    async removeForAgent(agentId) {
      return db.transaction().execute(async (trx) => {
        const channels = await trx.deleteFrom(CHANNELS).where('agent_id', '=', agentId).executeTakeFirst();
        const threads = await trx.deleteFrom(THREADS).where('agent_id', '=', agentId).executeTakeFirst();
        return { channels: Number(channels.numDeletedRows), threads: Number(threads.numDeletedRows) };
      });
    },

    async recordThread(t) {
      // One statement: the binding is read as the row is written, so a
      // binding removed or claimed after the router's read is seen here.
      // The conflict leaves `not_remembered` alone (TASK-1203): a new row
      // takes the column's default, false, so nothing marks a thread any
      // more, and a thread marked before keeps its mark. It only ever ORs
      // `external` in, so nothing turns an outsiders' thread into a member's.
      // No binding of this agent's: `binding` is empty, and nothing is
      // inserted or updated. An outsider's turn also needs the binding still
      // connected by the person it runs as (a reconnect after the router's
      // read): otherwise `binding` has its row but nothing is written, and
      // that difference is the answer. Anything but `attended` is an
      // outsider's turn, and one without a `runAs` matches no connector.
      //
      // A member's turn adds the names its label showed (TASK-1146), in the
      // same statement: the conflict keeps the union, each name once at the
      // place it was last seen, the THREAD_SPEAKER_NAMES_MAX most recent,
      // oldest first. In SQL, so two turns at once can't lose each other's
      // names. An outsider's turn adds none, whatever it was handed: memory
      // never learns from its thread. The names go in as ONE array
      // parameter (node-postgres writes a JS array as an array literal,
      // quoting each element), never spliced into the statement.
      const external = t.mode !== 'attended';
      const connector = t.mode === 'attended' ? sql`true` : sql`b.connected_by_user_id = ${t.runAs ?? null}`;
      const names = t.mode === 'attended' ? mostRecentNames(t.speakerNames) : [];
      const r = await sql<{ bound: number; recorded: number }>`
        WITH binding AS (
          SELECT c.install_id, c.channel_id, c.agent_id, c.connected_by_user_id
            FROM channel_slack_v1_channels c
           WHERE c.install_id = ${t.installId}
             AND c.channel_id = ${t.channelId}
             AND c.agent_id = ${t.agentId}
        ), recorded AS (
          INSERT INTO channel_slack_v1_threads
            (conversation_id, install_id, channel_id, agent_id, external, speaker_names)
          SELECT ${t.conversationId}, b.install_id, b.channel_id, b.agent_id, CAST(${external} AS boolean),
                 ${names}::text[]
            FROM binding b
           WHERE ${connector}
          ON CONFLICT (conversation_id) DO UPDATE
             SET external = channel_slack_v1_threads.external OR EXCLUDED.external,
                 speaker_names = (
                   SELECT COALESCE(array_agg(kept.n ORDER BY kept.seen), '{}')
                     FROM (
                       SELECT u.n, max(u.o) AS seen
                         FROM unnest(channel_slack_v1_threads.speaker_names || EXCLUDED.speaker_names)
                              WITH ORDINALITY AS u(n, o)
                        GROUP BY u.n
                        ORDER BY seen DESC
                        LIMIT ${THREAD_SPEAKER_NAMES_MAX}
                     ) AS kept
                 )
          RETURNING conversation_id
        )
        SELECT (SELECT count(*) FROM binding)::int AS bound, (SELECT count(*) FROM recorded)::int AS recorded
      `.execute(db);
      const row = r.rows[0];
      if (row === undefined || row.bound === 0) return 'no-binding';
      return row.recorded > 0 ? 'recorded' : 'reconnected';
    },

    async getThread(conversationId) {
      const row = await db
        .selectFrom(THREADS)
        .select(['install_id', 'channel_id', 'agent_id', 'not_remembered', 'external', 'speaker_names'])
        .where('conversation_id', '=', conversationId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            installId: row.install_id,
            channelId: row.channel_id,
            agentId: row.agent_id,
            notRemembered: row.not_remembered,
            external: row.external,
            speakerNames: row.speaker_names,
          };
    },
  };
}
