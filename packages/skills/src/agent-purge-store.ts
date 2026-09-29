/**
 * @ax/skills agent-purge store (TASK-718).
 *
 * Deleting an agent must take the skills rows keyed on it with it. Four
 * `skills_v1_*` tables carry an `agent_id` column and, by design, no FK to the
 * agents table (cross-plugin FKs are banned — invariant I4), so nothing but the
 * `agents:deleted` subscriber ever removes them:
 *
 *   - skills_v1_user_attachments — per-(user, agent) skill activation
 *   - skills_v1_quarantine       — per-(user, agent, skill) draft scan verdict
 *   - skills_v1_authored         — agent-authored skill drafts
 *   - skills_v1_approved_caps    — per-(user, agent, subject) capability grants
 *
 * The other skills tables (`skills_v1_skills`, `skills_v1_user_skills`,
 * `skills_v1_catalog_requests`, `skills_v1_skill_files`) have no agent column:
 * they belong to the workspace or to a user, not to an agent, and survive.
 *
 * Every delete is keyed on `agent_id` ALONE. A team agent has rows for several
 * owner users; scoping by owner would strand the rest. The content-addressed
 * bundle bytes behind `skills_v1_authored.bundle_tree_sha` are NOT touched —
 * the blob store dedups across skills, so a blob may be shared and reclaiming
 * it needs a reference authority this plugin does not have.
 */
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

const PLUGIN_NAME = '@ax/skills';

/** Rows removed per table by one {@link AgentPurgeStore.deleteAllForAgent}. */
export interface AgentPurgeCounts {
  userAttachments: number;
  quarantine: number;
  authored: number;
  approvedCaps: number;
}

export interface AgentPurgeStore {
  /**
   * Delete every row in the four agent-keyed tables whose `agent_id` is
   * `agentId`, for ALL owner users, in ONE transaction: either every table is
   * emptied for the agent or none is, so a failed purge leaves nothing half
   * done and a retry starts clean. Idempotent — an agent with no rows yields
   * all-zero counts.
   *
   * Throws on an empty `agentId` BEFORE any statement runs: an empty key must
   * never reach a `DELETE`.
   */
  deleteAllForAgent(agentId: string): Promise<AgentPurgeCounts>;
}

export function createAgentPurgeStore(db: Kysely<SkillsDatabase>): AgentPurgeStore {
  return {
    async deleteAllForAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          message: 'deleteAllForAgent requires a non-empty agentId',
        });
      }
      return db.transaction().execute(async (trx) => {
        const userAttachments = await trx
          .deleteFrom('skills_v1_user_attachments')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        const quarantine = await trx
          .deleteFrom('skills_v1_quarantine')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        const authored = await trx
          .deleteFrom('skills_v1_authored')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        const approvedCaps = await trx
          .deleteFrom('skills_v1_approved_caps')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        return {
          userAttachments: Number(userAttachments.numDeletedRows),
          quarantine: Number(quarantine.numDeletedRows),
          authored: Number(authored.numDeletedRows),
          approvedCaps: Number(approvedCaps.numDeletedRows),
        };
      });
    },
  };
}
