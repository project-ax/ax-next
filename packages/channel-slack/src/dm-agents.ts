import { sql, type Kysely } from 'kysely';
import type { ChannelSlackDatabase } from './migrations.js';

/**
 * Which of a person's personal agents answers their direct messages to the
 * shared Slack app (TASK-1238): one row per AX user, in
 * `channel_slack_v1_dm_agents`. The person picks it from a personal agent's
 * Slack settings (agent-routes.ts). With no row, their oldest "Just me"
 * personal agent answers, as before: one shared with other people answers no
 * DMs (TASK-1248).
 *
 * A row is never trusted as stored. The agent it names may have been deleted
 * since, or shared, or may no longer be this person's own personal agent, so
 * every read is checked against `agents:list-for-user` with the one
 * predicate the DM router uses (router.ts `personalAgentFor`), and a choice
 * that no longer qualifies is ignored: the oldest answers. That is why `get`
 * answers the id unchecked, and why nothing here asks anyone's rights. Who
 * may write a row is the route's to decide, never this file's.
 *
 * `removeForAgent` is the agents:deleted cleanup (agents-deleted.ts). A reset
 * leaves the rows behind, inert: they name accounts and agents that are gone,
 * and every read checks them. Keyed by the person, not by an install, so an
 * admin's Disconnect and Connect keep everyone's choice.
 */
export interface DmAgentStore {
  /**
   * The agent this person chose for their Slack DMs, or null. Unchecked:
   * callers check it (router.ts `personalAgentFor`).
   */
  get(userId: string): Promise<string | null>;
  /**
   * Choose it. Replaces any earlier choice: one row per person, written in ONE
   * statement, so two choices at once leave one row, naming one of them.
   */
  set(userId: string, agentId: string): Promise<void>;
  /** Forget every choice naming this agent. Returns how many went. */
  removeForAgent(agentId: string): Promise<number>;
}

const DM_AGENTS = 'channel_slack_v1_dm_agents';

export function createDmAgentStore(db: Kysely<ChannelSlackDatabase>): DmAgentStore {
  return {
    async get(userId) {
      const row = await db.selectFrom(DM_AGENTS).select('agent_id').where('user_id', '=', userId).executeTakeFirst();
      return row?.agent_id ?? null;
    },

    async set(userId, agentId) {
      // INSERT … ON CONFLICT (user_id) DO UPDATE: a concurrent choice by the
      // same person waits on the primary key, then takes the update. No
      // read-then-write window, and no primary-key error to answer.
      await db
        .insertInto(DM_AGENTS)
        .values({ user_id: userId, agent_id: agentId })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            agent_id: (eb) => eb.ref('excluded.agent_id'),
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    },

    async removeForAgent(agentId) {
      const r = await db.deleteFrom(DM_AGENTS).where('agent_id', '=', agentId).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}
