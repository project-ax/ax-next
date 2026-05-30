/**
 * @ax/skills approved-capabilities store (Phase 4). Per-(owner_user_id,
 * agent_id, skill_id, cap_kind, cap_value) record of what a human approved at
 * the wall for a self-authored draft. Every query is scoped to the compound key
 * — user A's rows MUST NEVER touch user B's. Owns `skills_v1_approved_caps`
 * only (Invariant I4 — one source of truth per concept).
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

/** The capability kinds an approval row can carry. */
export type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';

/**
 * One approved capability, storage-agnostic. The projection matches a draft's
 * proposal against (kind, value); `detail` (slot kind/account, MCP spec) is
 * audit/display metadata only and is NOT returned by list().
 */
export interface ApprovedCapEntry {
  kind: ApprovedCapKind;
  value: string;
}

export interface ApprovedCapsStore {
  set(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
    kind: ApprovedCapKind;
    value: string;
    detail?: unknown;
  }): Promise<{ created: boolean }>;
  clear(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
    kind: ApprovedCapKind;
    value: string;
  }): Promise<{ cleared: boolean }>;
  list(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
  }): Promise<ApprovedCapEntry[]>;
}

export function createApprovedCapsStore(db: Kysely<SkillsDatabase>): ApprovedCapsStore {
  return {
    async set({ ownerUserId, agentId, skillId, kind, value, detail }) {
      // Idempotent: a duplicate (kind, value) for the same skill is a no-op.
      // Accept the PK-violation race (mirrors host-grants / quarantine).
      const res = await db
        .insertInto('skills_v1_approved_caps')
        .values({
          owner_user_id: ownerUserId,
          agent_id: agentId,
          skill_id: skillId,
          cap_kind: kind,
          cap_value: value,
          cap_detail: detail === undefined ? null : (detail as unknown),
          created_at: new Date(),
        })
        .onConflict((oc) =>
          oc
            .columns(['owner_user_id', 'agent_id', 'skill_id', 'cap_kind', 'cap_value'])
            .doNothing(),
        )
        .executeTakeFirst();
      return { created: Number(res.numInsertedOrUpdatedRows ?? 0n) > 0 };
    },

    async clear({ ownerUserId, agentId, skillId, kind, value }) {
      const res = await db
        .deleteFrom('skills_v1_approved_caps')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .where('cap_kind', '=', kind)
        .where('cap_value', '=', value)
        .executeTakeFirst();
      return { cleared: Number(res.numDeletedRows ?? 0n) > 0 };
    },

    async list({ ownerUserId, agentId, skillId }) {
      const rows = await db
        .selectFrom('skills_v1_approved_caps')
        .select(['cap_kind', 'cap_value'])
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .orderBy('cap_kind', 'asc')
        .orderBy('cap_value', 'asc')
        .execute();
      return rows.map((r) => ({ kind: r.cap_kind as ApprovedCapKind, value: r.cap_value }));
    },
  };
}
