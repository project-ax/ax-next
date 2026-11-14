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
  /** Delete the agent's bindings on every install, and say how many went. */
  removeForAgent(agentId: string): Promise<number>;
}

const CHANNELS = 'channel_slack_v1_channels';

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
      const r = await db.deleteFrom(CHANNELS).where('agent_id', '=', agentId).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}
