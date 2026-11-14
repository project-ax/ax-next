import { sql, type Kysely, type Selectable } from 'kysely';
import { cleanChannelName } from './label.js';
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
 * conversations are channel threads, of which channel and agent, and whether
 * one ever had a turn while the switch was off. The capture veto
 * (capture-veto.ts) reads it; the router writes it when a channel turn
 * starts. Only `removeForAgent` deletes a thread row: an install's removal and
 * a disconnect keep them, so what was said while the switch was off stays out
 * of memory after Slack is gone.
 */
export interface ChannelBinding {
  installId: string;
  channelId: string;
  agentId: string;
  /** The team admin who connected the channel. Their name is auth's, read when shown. */
  connectedByUserId: string;
  /** Slack's name for the channel when it was connected, cleaned (label.ts). */
  channelName: string;
  /** The channel's memory switch. On for a new binding; a reconnect keeps it. */
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
}

export interface ChannelStore {
  get(installId: string, channelId: string): Promise<ChannelBinding | null>;
  /** This agent's channels on this install, oldest first. */
  listForAgent(installId: string, agentId: string): Promise<ChannelBinding[]>;
  /** Every binding on this install, whichever agent, in no particular order. */
  listAll(installId: string): Promise<Array<{ channelId: string; agentId: string }>>;
  /**
   * Connect a channel, in ONE statement, so of any number of concurrent
   * connects exactly one can bind a free channel. `connected`: a new binding
   * (remember on). `reconnected`: the channel was already this agent's; the
   * connector and name are replaced, and remember and createdAt kept.
   * `taken`: it is another agent's, and nothing changed. The name is stored
   * cleaned.
   */
  upsert(
    b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'>,
  ): Promise<'connected' | 'reconnected' | 'taken'>;
  /** Disconnect a channel from THIS agent. False when it isn't this agent's (or isn't bound at all). */
  remove(installId: string, channelId: string, agentId: string): Promise<boolean>;
  /** Flip THIS agent's channel's memory switch. False when it isn't this agent's (or isn't bound at all). */
  setRemember(installId: string, channelId: string, agentId: string, remember: boolean): Promise<boolean>;
  /**
   * Delete the agent's bindings and thread rows on every install, in one
   * transaction (both go, or neither does), and say how many of each went.
   */
  removeForAgent(agentId: string): Promise<{ channels: number; threads: number }>;
  /**
   * Record that a turn is starting in this conversation, in ONE statement
   * that reads the channel's memory switch as it writes: a switch turned off
   * after the caller read the binding still taints the thread. A
   * conversation's install, channel and agent are written the first time and
   * never change (its key names them); `notRemembered` is sticky: once true,
   * a turn with the switch on leaves it true. `no-binding`: the channel isn't
   * this agent's (any more), nothing was written, and the turn must not run.
   */
  recordThread(t: Omit<ChannelThread, 'notRemembered'> & { conversationId: string }): Promise<'recorded' | 'no-binding'>;
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
  'remember',
  'created_at',
] as const;

type SelectedRow = Pick<Selectable<ChannelSlackChannelsTable>, (typeof COLUMNS)[number]>;

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
      // row, so it tells a new binding from a reconnect.
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

    async setRemember(installId, channelId, agentId, remember) {
      const r = await db
        .updateTable(CHANNELS)
        .set({ remember, updated_at: sql<Date>`now()` })
        .where('install_id', '=', installId)
        .where('channel_id', '=', channelId)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },

    async removeForAgent(agentId) {
      return db.transaction().execute(async (trx) => {
        const channels = await trx.deleteFrom(CHANNELS).where('agent_id', '=', agentId).executeTakeFirst();
        const threads = await trx.deleteFrom(THREADS).where('agent_id', '=', agentId).executeTakeFirst();
        return { channels: Number(channels.numDeletedRows), threads: Number(threads.numDeletedRows) };
      });
    },

    async recordThread(t) {
      // One statement: the switch is read from the binding as the row is
      // written, so an admin turning it off after the router's read can't
      // leave a thread recorded clean; and two turns starting at once in one
      // thread can't lose a taint between a read and a write. The conflict
      // only ever ORs the flag in, so nothing can turn a thread back to
      // remembered. No binding of this agent's, no row selected: nothing is
      // inserted, nothing updated, nothing returned.
      const r = await sql<{ conversation_id: string }>`
        INSERT INTO channel_slack_v1_threads
          (conversation_id, install_id, channel_id, agent_id, not_remembered)
        SELECT ${t.conversationId}, c.install_id, c.channel_id, c.agent_id, NOT c.remember
          FROM channel_slack_v1_channels c
         WHERE c.install_id = ${t.installId}
           AND c.channel_id = ${t.channelId}
           AND c.agent_id = ${t.agentId}
        ON CONFLICT (conversation_id) DO UPDATE
           SET not_remembered = channel_slack_v1_threads.not_remembered OR EXCLUDED.not_remembered
        RETURNING conversation_id
      `.execute(db);
      return r.rows.length === 0 ? 'no-binding' : 'recorded';
    },

    async getThread(conversationId) {
      const row = await db
        .selectFrom(THREADS)
        .select(['install_id', 'channel_id', 'agent_id', 'not_remembered'])
        .where('conversation_id', '=', conversationId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { installId: row.install_id, channelId: row.channel_id, agentId: row.agent_id, notRemembered: row.not_remembered };
    },
  };
}
