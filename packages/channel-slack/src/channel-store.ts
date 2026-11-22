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
 * answers `taken`), and `remove`/`setPrivate` with another agent's id
 * change nothing. Who may bind a channel is the caller's to decide
 * (channels.ts), never this file's.
 *
 * Removing an install removes its bindings in the same statement (store.ts);
 * `removeForAgent` is the agents:deleted cleanup (agents-deleted.ts).
 *
 * It also keeps the thread map (TASK-1094): which conversations are channel
 * threads, of which channel and agent, whether outsiders' turns run in it,
 * and whether one ever had a turn while the channel was private
 * (TASK-1188); and, for a member's thread, the names their turns were
 * labelled with (TASK-1146). The capture veto (capture-veto.ts) reads it;
 * the router writes it when a channel turn starts. Only `removeForAgent`
 * deletes a thread row: an install's removal and a disconnect keep them, so
 * what was said in private stays out of memory after Slack is gone.
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
  /**
   * Slack last described the channel as private (TASK-1188, design §4b.3):
   * the bot answers there, and memory never learns from it
   * (capture-veto.ts). Set at the bind and by `setPrivate`.
   */
  isPrivate: boolean;
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
   * True once any turn started while the channel was private (TASK-1188),
   * an Allow's continuation included (`markNotRemembered`). Never cleared,
   * whatever set it: a thread said in private stays out of memory if the
   * channel goes public.
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
   * stores no shared statement whose subject is made of them. Empty for an
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
   * name are replaced, and the stored privacy and createdAt kept. `taken`: it
   * is another agent's, and nothing changed. The name is stored cleaned.
   * `isPrivate` (off when not given) is written by a new binding only: a
   * turn's check moves it (`setPrivate`). A team agent's own bot binds a
   * channel with this at its first mention there (router.ts
   * `bindBotChannel`).
   */
  upsert(
    b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'> & {
      isPrivate?: boolean;
    },
  ): Promise<'connected' | 'reconnected' | 'taken'>;
  /** Disconnect a channel from THIS agent. False when it isn't this agent's (or isn't bound at all). */
  remove(installId: string, channelId: string, agentId: string): Promise<boolean>;
  /**
   * Record whether Slack now describes the channel as private (TASK-1188),
   * on `installId`'s binding of it, only when that binding is THIS agent's.
   * False when it isn't (or the channel isn't bound).
   */
  setPrivate(installId: string, channelId: string, agentId: string, isPrivate: boolean): Promise<boolean>;
  /**
   * Mark a thread not remembered, for good (TASK-1188): an Allow continuation
   * ran in it while its channel was private. Nothing when it isn't a thread.
   */
  markNotRemembered(conversationId: string): Promise<void>;
  /**
   * Delete the agent's bindings and thread rows on every install, in one
   * transaction (both go, or neither does), and say how many of each went.
   */
  removeForAgent(agentId: string): Promise<{ channels: number; threads: number }>;
  /**
   * Record that a turn is starting in this conversation, in ONE statement
   * that reads the binding as it writes. A conversation's install, channel
   * and agent are written the first time and never change (its key names
   * them). A private channel marks the thread not remembered (TASK-1188):
   * `isPrivate`, what the turn's own check said, or the binding's
   * `isPrivate` as it is at the write, so a channel made private after the
   * caller read the binding still marks it. `notRemembered` is sticky: once
   * true, a later turn in a public channel leaves it true. `external` is the
   * turn's mode (anything but `attended` counts as external) and sticky the
   * same way.
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
      isPrivate: boolean;
    } & ThreadTurn,
  ): Promise<'recorded' | 'no-binding' | 'reconnected'>;
  /** The thread a conversation is, or null when no channel turn ever ran in it (a web chat, a DM). */
  getThread(conversationId: string): Promise<ChannelThread | null>;
}

const CHANNELS = 'channel_slack_v1_channels';
const THREADS = 'channel_slack_v1_threads';

const COLUMNS = [
  'install_id',
  'channel_id',
  'agent_id',
  'connected_by_user_id',
  'channel_name',
  'is_private',
  'created_at',
] as const;

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
    isPrivate: r.is_private,
    createdAt: r.created_at,
  };
}

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
      // row, so it tells a new binding from a reconnect. `is_private` is
      // written by the insert only: the conflict's SET leaves it alone.
      const r = await sql<{ inserted: boolean }>`
        INSERT INTO channel_slack_v1_channels
          (install_id, channel_id, agent_id, connected_by_user_id, channel_name, is_private)
        VALUES
          (${b.installId}, ${b.channelId}, ${b.agentId}, ${b.connectedByUserId}, ${cleanChannelName(b.channelName)},
           ${b.isPrivate ?? false})
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

    async setPrivate(installId, channelId, agentId, isPrivate) {
      const r = await db
        .updateTable(CHANNELS)
        .set({ is_private: isPrivate, updated_at: new Date() })
        .where('install_id', '=', installId)
        .where('channel_id', '=', channelId)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },

    async markNotRemembered(conversationId) {
      await db.updateTable(THREADS).set({ not_remembered: true }).where('conversation_id', '=', conversationId).execute();
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
      // channel made private after the router's read can't leave a thread
      // recorded clean; and two turns starting at once in one thread can't
      // lose a mark between a read and a write. The conflict only ever ORs
      // the flags in, so nothing can turn a thread back to remembered, or an
      // outsiders' thread into a member's. No binding of this agent's:
      // `binding` is empty, and nothing is inserted or updated. An outsider's
      // turn also needs the binding still connected by the person it runs as
      // (a reconnect after the router's read): otherwise `binding` has its
      // row but nothing is written, and that difference is the answer.
      // Anything but `attended` is an outsider's turn, and one without a
      // `runAs` matches no connector.
      //
      // A private channel (TASK-1188) marks the thread not remembered: what
      // this turn's own check said, or the binding as it is at this write (a
      // newer check may have set it meanwhile).
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
      // Anything but a plain `false` is private: a caller that didn't say keeps memory out.
      const privateTurn = t.isPrivate !== false;
      const connector = t.mode === 'attended' ? sql`true` : sql`b.connected_by_user_id = ${t.runAs ?? null}`;
      const names = t.mode === 'attended' ? mostRecentNames(t.speakerNames) : [];
      const r = await sql<{ bound: number; recorded: number }>`
        WITH binding AS (
          SELECT c.install_id, c.channel_id, c.agent_id, c.is_private, c.connected_by_user_id
            FROM channel_slack_v1_channels c
           WHERE c.install_id = ${t.installId}
             AND c.channel_id = ${t.channelId}
             AND c.agent_id = ${t.agentId}
        ), recorded AS (
          INSERT INTO channel_slack_v1_threads
            (conversation_id, install_id, channel_id, agent_id, not_remembered, external, speaker_names)
          SELECT ${t.conversationId}, b.install_id, b.channel_id, b.agent_id,
                 b.is_private OR CAST(${privateTurn} AS boolean), CAST(${external} AS boolean),
                 ${names}::text[]
            FROM binding b
           WHERE ${connector}
          ON CONFLICT (conversation_id) DO UPDATE
             SET not_remembered = channel_slack_v1_threads.not_remembered OR EXCLUDED.not_remembered,
                 external = channel_slack_v1_threads.external OR EXCLUDED.external,
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
