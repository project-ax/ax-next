/**
 * @ax/skills quarantine store (Phase 2). Per-(owner_user_id, agent_id, skill_id)
 * draft-skill safety status. Every query is scoped to the compound key — user A's
 * rows MUST NEVER touch user B's, and agent a1's flags never bleed into a2. Owns
 * `skills_v1_quarantine` only (Invariant I4 — one source of truth per concept).
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

export interface QuarantineRecord {
  skillId: string;
  reason: string;
  /** ISO-8601 timestamp the flag was last set/refreshed. */
  lastFlaggedAt: string;
}

export interface SkillsQuarantineStore {
  set(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
    reason: string;
  }): Promise<void>;
  clear(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
  }): Promise<{ cleared: boolean }>;
  get(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
  }): Promise<{ quarantined: boolean; reason?: string }>;
  list(input: { ownerUserId: string; agentId: string }): Promise<QuarantineRecord[]>;
}

export function createSkillsQuarantineStore(
  db: Kysely<SkillsDatabase>,
): SkillsQuarantineStore {
  return {
    async set({ ownerUserId, agentId, skillId, reason }) {
      // Upsert: the latest scan reason wins (a re-scan that still flags updates
      // the message). created_at refreshes so list() reflects the latest hit.
      const now = new Date();
      await db
        .insertInto('skills_v1_quarantine')
        .values({
          owner_user_id: ownerUserId,
          agent_id: agentId,
          skill_id: skillId,
          reason,
          created_at: now,
        })
        .onConflict((oc) =>
          oc
            .columns(['owner_user_id', 'agent_id', 'skill_id'])
            .doUpdateSet({ reason, created_at: now }),
        )
        .execute();
    },

    async clear({ ownerUserId, agentId, skillId }) {
      const res = await db
        .deleteFrom('skills_v1_quarantine')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .executeTakeFirst();
      return { cleared: Number(res.numDeletedRows ?? 0n) > 0 };
    },

    async get({ ownerUserId, agentId, skillId }) {
      const row = await db
        .selectFrom('skills_v1_quarantine')
        .select('reason')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .executeTakeFirst();
      return row === undefined
        ? { quarantined: false }
        : { quarantined: true, reason: row.reason };
    },

    async list({ ownerUserId, agentId }) {
      const rows = await db
        .selectFrom('skills_v1_quarantine')
        .select(['skill_id', 'reason', 'created_at'])
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .orderBy('skill_id', 'asc')
        .execute();
      return rows.map((r) => ({
        skillId: r.skill_id,
        reason: r.reason,
        lastFlaggedAt: r.created_at.toISOString(),
      }));
    },
  };
}
