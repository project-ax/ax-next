import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { cleanChannelName } from './label.js';
import { THREAD_SPEAKER_NAMES_MAX } from './limits.js';
import type { ChannelSlackChannelsTable, ChannelSlackDatabase } from './migrations.js';

/**
 * Which team agent a Slack channel is connected to (TASK-1094): one agent per
 * channel, any number of channels per agent.
 *
 * A binding decides whose identity the channel's outsiders run as (the person
 * who connected it), so every write here is scoped to the agent the caller
 * named, the one it checked rights on: a second agent never takes a channel
 * over (`upsert` answers `taken`), and `remove`/`setRemember` with another
 * agent's id change nothing. Who may connect is the caller's to decide
 * (channels.ts), never this file's.
 *
 * Removing an install removes its bindings in the same statement (store.ts);
 * `removeForAgent` is the agents:deleted cleanup (agents-deleted.ts).
 *
 * It also keeps the memory switch's thread map (TASK-1094): which
 * conversations are channel threads, of which channel and agent, whether
 * outsiders' turns run in it, and whether one ever had a turn while the
 * switch was off; and, for a member's thread, the names their turns were
 * labelled with (TASK-1146). The capture veto (capture-veto.ts) reads it;
 * the router writes it when a channel turn starts. Only `removeForAgent`
 * deletes a thread row: an install's removal and a disconnect keep them, so
 * what was said while the switch was off stays out of memory after Slack is
 * gone.
 *
 * And the memory switch the team last set for an agent in a channel, kept
 * apart from the bindings (TASK-1180), so a Disconnect never loses it. A flip
 * (`setRemember`) writes every binding of that agent in that channel, on any
 * install, and the kept switch, in ONE statement, so a flip leaves the kept
 * switch agreeing with every binding it reached; and a bot channel switched
 * off is off on the shared binding too, which the shared bot answers with
 * again once the bot is gone. `bindBot`, a team agent's own bot's first bind
 * there, reads it. An install's removal and a disconnect
 * keep it; only `removeForAgent` deletes it. Any future writer that flips a
 * binding's `remember` must keep that one-statement rule. `upsert`'s insert
 * is the one exception, on purpose: a new binding's starting switch is not
 * a flip, so it keeps nothing (a fresh connect starts on beside whatever is
 * kept, and the bot's first bind reads a live binding before the kept
 * switch). The two can also differ after a flip by code from before the
 * table (an older replica, or a rollback), which writes the binding alone;
 * the next boot moves the kept switch toward off (migrations.ts).
 *
 * A flip and a team agent's own bot's first bind never interleave
 * (TASK-1182): each takes the switch lock on the agent and channel
 * (`lockSwitch`) as its transaction's first statement and reads only after
 * it, so whichever comes second sees what the other wrote. Any future
 * writer that flips a binding's `remember` takes it too. A fresh connect on
 * the shared app (`upsert`, channels.ts) is the one writer without it, on
 * purpose: a new binding starts on, which is not a flip; a reconnect never
 * writes `remember`; and a connect is refused once the agent's own bot is
 * live (channels.ts `liveOwnBot`).
 */
export interface ChannelBinding {
  installId: string;
  channelId: string;
  agentId: string;
  /** The team admin who connected the channel. Their name is auth's, read when shown. */
  connectedByUserId: string;
  /** Slack's name for the channel when it was connected, cleaned (label.ts). */
  channelName: string;
  /**
   * The channel's memory switch. On for a new binding unless its writer says
   * otherwise (a team agent's own bot starts from the agent's switch for the
   * channel, TASK-1179/1180); a reconnect keeps it.
   */
  remember: boolean;
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
  /** True once any turn started while the channel's memory switch was off. Never cleared. */
  notRemembered: boolean;
  /**
   * The conversation outsiders' (external) turns run in: memory never learns
   * from it, whatever the switch says. Fixed by the conversation's key.
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
 * (`speakerNames`); or an outsider's, run as the person who connected the
 * channel when it was planned (`external`, `runAs`), which brings no names.
 */
export type ThreadTurn = { mode: 'attended'; speakerNames: readonly string[] } | { mode: 'external'; runAs: string };

export interface ChannelStore {
  get(installId: string, channelId: string): Promise<ChannelBinding | null>;
  /** This agent's channels on this install, oldest first. */
  listForAgent(installId: string, agentId: string): Promise<ChannelBinding[]>;
  /** Every binding on this install, whichever agent, in no particular order. */
  listAll(installId: string): Promise<Array<{ channelId: string; agentId: string }>>;
  /**
   * Connect a channel, in ONE statement, so of any number of concurrent
   * connects exactly one can bind a free channel. `connected`: a new binding,
   * its memory switch `remember` (on when not given). `reconnected`: the
   * channel was already this agent's; the connector and name are replaced,
   * and the stored remember and createdAt kept (`remember` is ignored).
   * `taken`: it is another agent's, and nothing changed. The name is stored
   * cleaned.
   */
  upsert(
    b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'> & {
      remember?: boolean;
    },
  ): Promise<'connected' | 'reconnected' | 'taken'>;
  /**
   * Disconnect a channel from THIS agent. False when it isn't this agent's (or isn't bound at all).
   * The switch kept for the agent and channel (keptRemember) stays.
   */
  remove(installId: string, channelId: string, agentId: string): Promise<boolean>;
  /**
   * Flip the agent's memory switch for a channel. `installId`'s binding of
   * the channel must be THIS agent's, else false and nothing is written.
   * Then, in ONE statement, every binding of the agent in that channel, on
   * any install (its shared binding while its own bot answers there, and the
   * bot's), takes it, and so does the switch kept apart from the bindings
   * (keptRemember). Another agent's rows and other channels are never
   * touched. True when the named binding took it. A Disconnect can delete
   * the named binding while the flip waits on it: then false, though the
   * agent's other bindings of the channel and the kept switch took it,
   * together. It takes the switch lock first (TASK-1182), so it waits for a
   * bot's first bind of the channel that is in progress, then reaches the
   * binding that bind wrote.
   */
  setRemember(installId: string, channelId: string, agentId: string, remember: boolean): Promise<boolean>;
  /**
   * The switch last set for this agent in this channel (TASK-1180): kept
   * when the bindings go (a Disconnect, a removed install, a removed bot),
   * deleted only with the agent. Null when none was ever set or backfilled.
   */
  keptRemember(agentId: string, channelId: string): Promise<boolean | null>;
  /**
   * A team agent's own bot's first bind of a channel (TASK-1167): `b` is
   * written as `upsert` writes it, with the memory switch the team last set
   * for the agent there: the agent's binding of the channel on the shared
   * app's install (`sharedInstallId`, null when there is none), else the
   * switch kept for the agent and channel (keptRemember), else on. Another
   * agent's binding there is about that agent's memory and is never read.
   * Read and written in one transaction holding the lock `setRemember`
   * takes on this agent and channel, so a flip and this bind never
   * interleave: a flip that came first is what it reads, and one that comes
   * second reaches the binding it wrote (TASK-1182). It keeps nothing: a new
   * binding's starting switch is not a flip. It answers the switch it read,
   * which a new binding is written with; a reconnect keeps the stored one
   * (as `upsert` does), so the caller reads the binding back. A failed read
   * throws before anything is written: the switch is never guessed.
   */
  bindBot(
    b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'>,
    sharedInstallId: string | null,
  ): Promise<boolean>;
  /**
   * Delete the agent's bindings, thread rows and kept switches on every
   * install, in one transaction (all go, or none does), and say how many
   * bindings and threads went.
   */
  removeForAgent(agentId: string): Promise<{ channels: number; threads: number }>;
  /**
   * Record that a turn is starting in this conversation, in ONE statement
   * that reads the channel's memory switch as it writes: a switch turned off
   * after the caller read the binding still taints the thread. A
   * conversation's install, channel and agent are written the first time and
   * never change (its key names them); `notRemembered` is sticky: once true,
   * a turn with the switch on leaves it true. `external` is the turn's mode
   * (anything but `attended` counts as external) and sticky the same way.
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
    t: Omit<ChannelThread, 'notRemembered' | 'external' | 'speakerNames'> & { conversationId: string } & ThreadTurn,
  ): Promise<'recorded' | 'no-binding' | 'reconnected'>;
  /** The thread a conversation is, or null when no channel turn ever ran in it (a web chat, a DM). */
  getThread(conversationId: string): Promise<ChannelThread | null>;
}

const CHANNELS = 'channel_slack_v1_channels';
const THREADS = 'channel_slack_v1_threads';
const SWITCHES = 'channel_slack_v1_memory_switches';

/**
 * The switch lock on an agent and channel (TASK-1182), taken by a flip
 * (`setRemember`) and by a team agent's own bot's first bind (`bindBot`) as
 * the first statement of their transactions, so the two never interleave.
 * An advisory lock, not a row's: the switch kept for the agent and channel
 * may have no row yet (a channel connected since the last boot and never
 * flipped), and the bot's new binding has none until the bind writes it,
 * while a lock on a key holds for rows that don't exist. A statement of its
 * own, before anything is read: a statement's snapshot is taken as it
 * starts, so one that waited for the lock inside itself would still decide
 * with what it saw before the wait. That is READ COMMITTED: under
 * REPEATABLE READ or SERIALIZABLE the transaction's one snapshot is taken by
 * its first statement, this one, before the wait, so both transactions that
 * take it set READ COMMITTED themselves rather than trust the server's
 * default. Transaction-scoped, never session-scoped: commit or rollback
 * releases it, so a pooled connection never keeps it. The seed is this
 * package's: routines use 1842713x, tool-policy 1842714x, decisions
 * 1842715x, channel-slack 18427161. The key is JSON, so no two (agent,
 * channel) pairs spell the same text; two whose hashes collide only wait
 * for each other. Outside a transaction it would be released as soon as
 * it was taken, so it takes only a transaction.
 */
async function lockSwitch(trx: Transaction<ChannelSlackDatabase>, agentId: string, channelId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([agentId, channelId])}, 18427161))`.execute(trx);
}

const COLUMNS = [
  'install_id',
  'channel_id',
  'agent_id',
  'connected_by_user_id',
  'channel_name',
  'remember',
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
    remember: r.remember,
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

    async listAll(installId) {
      const rows = await db
        .selectFrom(CHANNELS)
        .select(['channel_id', 'agent_id'])
        .where('install_id', '=', installId)
        .execute();
      return rows.map((r) => ({ channelId: r.channel_id, agentId: r.agent_id }));
    },

    async upsert(b) {
      // The conflict's UPDATE runs only when the row is already this agent's
      // (its WHERE), so another agent's connect returns no row and changes
      // nothing. A concurrent insert of the same channel waits on the primary
      // key, then takes that same conflict path: one statement, no
      // read-then-write window. `xmax = 0` holds only for a freshly inserted
      // row, so it tells a new binding from a reconnect. `remember` is
      // written by the insert only: the conflict's SET leaves it alone.
      const r = await sql<{ inserted: boolean }>`
        INSERT INTO channel_slack_v1_channels
          (install_id, channel_id, agent_id, connected_by_user_id, channel_name, remember)
        VALUES
          (${b.installId}, ${b.channelId}, ${b.agentId}, ${b.connectedByUserId}, ${cleanChannelName(b.channelName)},
           ${b.remember ?? true})
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

    async setRemember(installId, channelId, agentId, remember) {
      // One statement, so the kept switch ends up agreeing with every binding
      // the flip reached. Every row it flips is this agent's, in this channel,
      // and only when the binding the caller named is this agent's (the
      // EXISTS, read as the statement starts): a route that checked rights on
      // one agent can't touch another's. The kept switch is written whenever
      // any binding was flipped, so it goes with them even when a Disconnect
      // deletes the named binding while the flip waits on its row: that row
      // is skipped, and the agent's other bindings still flip. The answer is
      // whether the named binding took it: false then, so the caller's page
      // re-reads and finds it gone. A bare parameter in a SELECT list has no
      // type, so each is cast.
      const flip = sql<{ changed: number }>`
        WITH flipped AS (
          UPDATE channel_slack_v1_channels
             SET remember = ${remember}, updated_at = now()
           WHERE channel_id = ${channelId}
             AND agent_id = ${agentId}
             AND EXISTS (
               SELECT 1 FROM channel_slack_v1_channels n
                WHERE n.install_id = ${installId} AND n.channel_id = ${channelId} AND n.agent_id = ${agentId}
             )
          RETURNING install_id
        ), kept AS (
          INSERT INTO channel_slack_v1_memory_switches (agent_id, channel_id, remember)
          SELECT CAST(${agentId} AS text), CAST(${channelId} AS text), CAST(${remember} AS boolean)
           WHERE EXISTS (SELECT 1 FROM flipped)
          ON CONFLICT (agent_id, channel_id) DO UPDATE SET remember = EXCLUDED.remember, updated_at = now()
        )
        SELECT (SELECT count(*) FROM flipped WHERE install_id = ${installId})::int AS changed
      `;
      // The switch lock first, in a statement of its own (lockSwitch): a bot's
      // first bind of the channel in progress commits before `flip` runs and
      // takes its snapshot, so the binding it wrote is one this flip reaches
      // (TASK-1182).
      return db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
        await lockSwitch(trx, agentId, channelId);
        const r = await flip.execute(trx);
        return (r.rows[0]?.changed ?? 0) > 0;
      });
    },

    async keptRemember(agentId, channelId) {
      const row = await db
        .selectFrom(SWITCHES)
        .select('remember')
        .where('agent_id', '=', agentId)
        .where('channel_id', '=', channelId)
        .executeTakeFirst();
      return row?.remember ?? null;
    },

    async bindBot(b, sharedInstallId) {
      return db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
        // The switch lock first, in a statement of its own (lockSwitch): a
        // flip of the channel in progress commits before anything below reads.
        await lockSwitch(trx, b.agentId, b.channelId);
        // This store on the transaction, so every read and the write below
        // hold the lock, on the transaction's one connection. Only its get,
        // keptRemember and upsert: setRemember, bindBot and removeForAgent
        // each open a transaction, which a transaction can't.
        const locked = createChannelStore(trx);
        // The agent's live shared binding comes first: a fresh connect keeps
        // no switch, so that binding is never staler than the kept one, which
        // only matters once it is gone. Another agent's binding is about that
        // agent's memory.
        const shared = sharedInstallId === null ? null : await locked.get(sharedInstallId, b.channelId);
        const remember =
          (shared !== null && shared.agentId === b.agentId ? shared.remember : null) ??
          (await locked.keptRemember(b.agentId, b.channelId)) ??
          true;
        await locked.upsert({ ...b, remember });
        return remember;
      });
    },

    async removeForAgent(agentId) {
      return db.transaction().execute(async (trx) => {
        const channels = await trx.deleteFrom(CHANNELS).where('agent_id', '=', agentId).executeTakeFirst();
        const threads = await trx.deleteFrom(THREADS).where('agent_id', '=', agentId).executeTakeFirst();
        await trx.deleteFrom(SWITCHES).where('agent_id', '=', agentId).execute();
        return { channels: Number(channels.numDeletedRows), threads: Number(threads.numDeletedRows) };
      });
    },

    async recordThread(t) {
      // One statement: the switch is read from the binding as the row is
      // written, so an admin turning it off after the router's read can't
      // leave a thread recorded clean; and two turns starting at once in one
      // thread can't lose a taint between a read and a write. The conflict
      // only ever ORs the flags in, so nothing can turn a thread back to
      // remembered, or an outsiders' thread into a member's. No binding of
      // this agent's: `binding` is empty, and nothing is inserted or updated.
      // An outsider's turn also needs the binding still connected by the
      // person it runs as (a reconnect after the router's read): otherwise
      // `binding` has its row but nothing is written, and that difference is
      // the answer. Anything but `attended` is an outsider's turn, and one
      // without a `runAs` matches no connector.
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
          SELECT c.install_id, c.channel_id, c.agent_id, c.remember, c.connected_by_user_id
            FROM channel_slack_v1_channels c
           WHERE c.install_id = ${t.installId}
             AND c.channel_id = ${t.channelId}
             AND c.agent_id = ${t.agentId}
        ), recorded AS (
          INSERT INTO channel_slack_v1_threads
            (conversation_id, install_id, channel_id, agent_id, not_remembered, external, speaker_names)
          SELECT ${t.conversationId}, b.install_id, b.channel_id, b.agent_id, NOT b.remember, CAST(${external} AS boolean),
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
