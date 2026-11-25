import { PluginError } from '@ax/core';
import type { Kysely, Transaction } from 'kysely';
import type { AgentsDatabase } from '../migrations.js';
import type { AgentAudience, AudienceMember, CallerFacts } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-1246 — the queries on `agents_v1_owners` and `agents_v1_audience_members`
// (eslint `local/no-bare-tenant-tables` keeps tenant-table queries in store
// files). The agent store writes the only others: the creator's owner row at
// create, and the purge in deleteById.
//
// Plain storage: no ACL, no check that a named person exists, no caps. The
// sharing service does those before it gets here. Phase 1 names people only,
// so this never writes a `group` member row, and one that exists anyway is
// never read as a listed person.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/agents';

export interface SharingStore {
  /**
   * Is `userId` one of the agent's owners, and does a list name them? ONE
   * query. Facts only: `listed` says a member row exists, not that the
   * agent's audience is `list`. The access check decides what they grant.
   */
  callerFacts(agentId: string, userId: string): Promise<CallerFacts>;
  /** The owners' user ids, oldest row first (so the creator leads), then by id. */
  listOwners(agentId: string): Promise<string[]>;
  /** The people a list names, oldest row first, then by id. Group rows are left out. */
  listMembers(agentId: string): Promise<AudienceMember[]>;
  /**
   * Set the agent's audience. ONE transaction holding the agent row lock: the
   * audience is written and every member row deleted, then a `list`'s members
   * are inserted. Throws `not-found` when the agent is gone.
   */
  setAudience(agentId: string, audience: AgentAudience): Promise<void>;
  /**
   * Make the agent's owners exactly `userIds`. ONE transaction holding the
   * agent row lock: owners not named are deleted and new ones inserted. An
   * owner who stays keeps their row, and with it their place in listOwners.
   * Throws `not-found` when the agent is gone.
   */
  setOwners(agentId: string, userIds: readonly string[]): Promise<void>;
}

/**
 * Lock the agent row for the rest of the transaction, or throw `not-found`.
 * deleteById takes the same lock first, so a sharing write and a delete never
 * interleave: the delete finishes first (and this finds no agent), or it waits
 * and then purges what this wrote. Two sharing writes to one agent take turns.
 */
async function lockAgent(trx: Transaction<AgentsDatabase>, agentId: string): Promise<void> {
  const agent = await trx
    .selectFrom('agents_v1_agents')
    .select('agent_id')
    .where('agent_id', '=', agentId)
    // Serialises sharing writes against deleteById; lock strength is not unit-tested.
    .forUpdate()
    .executeTakeFirst();
  if (agent === undefined) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      message: `agent '${agentId}' not found`,
    });
  }
}

export function createSharingStore(db: Kysely<AgentsDatabase>): SharingStore {
  return {
    async callerFacts(agentId, userId) {
      const row = await db
        .selectNoFrom((eb) => [
          eb
            .exists(
              eb
                .selectFrom('agents_v1_owners')
                .select('agent_id')
                .where('agent_id', '=', agentId)
                .where('user_id', '=', userId),
            )
            .as('owner'),
          eb
            .exists(
              eb
                .selectFrom('agents_v1_audience_members')
                .select('agent_id')
                .where('agent_id', '=', agentId)
                .where('member_type', '=', 'user')
                .where('member_id', '=', userId),
            )
            .as('listed'),
        ])
        .executeTakeFirstOrThrow();
      // Only a real `true` counts: anything else reads as "no".
      return { owner: row.owner === true, listed: row.listed === true };
    },

    async listOwners(agentId) {
      const rows = await db
        .selectFrom('agents_v1_owners')
        .select('user_id')
        .where('agent_id', '=', agentId)
        .orderBy('created_at')
        .orderBy('user_id')
        .execute();
      return rows.map((r) => r.user_id);
    },

    async listMembers(agentId) {
      const rows = await db
        .selectFrom('agents_v1_audience_members')
        .select('member_id')
        .where('agent_id', '=', agentId)
        .where('member_type', '=', 'user')
        .orderBy('created_at')
        .orderBy('member_id')
        .execute();
      return rows.map((r): AudienceMember => ({ type: 'user', id: r.member_id }));
    },

    async setAudience(agentId, audience) {
      await db.transaction().execute(async (trx) => {
        await lockAgent(trx, agentId);
        await trx
          .updateTable('agents_v1_agents')
          .set({ audience: audience.kind, updated_at: new Date() })
          .where('agent_id', '=', agentId)
          .execute();
        // Every member row goes, of any type and whatever the new audience:
        // a row that outlived its list must never grant anything.
        await trx
          .deleteFrom('agents_v1_audience_members')
          .where('agent_id', '=', agentId)
          .execute();
        if (audience.kind === 'list' && audience.members.length > 0) {
          await trx
            .insertInto('agents_v1_audience_members')
            .values(
              audience.members.map((m) => ({
                agent_id: agentId,
                // People only in phase 1, whatever a caller sends.
                member_type: 'user',
                member_id: m.id,
              })),
            )
            // A person named twice is one member (same as setOwners).
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      });
    },

    async setOwners(agentId, userIds) {
      await db.transaction().execute(async (trx) => {
        await lockAgent(trx, agentId);
        let dropped = trx.deleteFrom('agents_v1_owners').where('agent_id', '=', agentId);
        if (userIds.length > 0) dropped = dropped.where('user_id', 'not in', [...userIds]);
        await dropped.execute();
        if (userIds.length > 0) {
          await trx
            .insertInto('agents_v1_owners')
            .values(userIds.map((userId) => ({ agent_id: agentId, user_id: userId })))
            .onConflict((oc) => oc.columns(['agent_id', 'user_id']).doNothing())
            .execute();
        }
      });
    },
  };
}
