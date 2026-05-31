/**
 * @ax/skills approved-capabilities store (Phase 4; TASK-93 connector subjects).
 * Per-(owner_user_id, agent_id, SUBJECT, cap_kind, cap_value) record of what a
 * human approved at the wall for a model-authored draft. The SUBJECT is exactly
 * one of {skill, connector} — TASK-93 reuses this SAME wall for agent-authored
 * connectors rather than forking a parallel store (Invariant I4 — one source of
 * truth per concept). Every query is scoped to the full compound key — user A's
 * rows MUST NEVER touch user B's, and a skill grant never collides with a
 * connector grant of the same id. Owns `skills_v1_approved_caps` only.
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

/** The capability kinds an approval row can carry. */
export type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';

/**
 * The grant subject — exactly one of a skill or a connector. The wall attributes
 * each approved capability to one of these (design: "the approval store's
 * compound key extends from (owner, agent, skill, ...) to cover connectors").
 * `skillId`/`connectorId` are opaque domain slugs (no backend vocabulary).
 */
export type ApprovedCapSubject = { skillId: string } | { connectorId: string };

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
  set(
    input: {
      ownerUserId: string;
      agentId: string;
      kind: ApprovedCapKind;
      value: string;
      detail?: unknown;
    } & ApprovedCapSubject,
  ): Promise<{ created: boolean }>;
  clear(
    input: {
      ownerUserId: string;
      agentId: string;
      kind: ApprovedCapKind;
      value: string;
    } & ApprovedCapSubject,
  ): Promise<{ cleared: boolean }>;
  list(
    input: {
      ownerUserId: string;
      agentId: string;
    } & ApprovedCapSubject,
  ): Promise<ApprovedCapEntry[]>;
}

/**
 * Normalize the discriminated subject ref into the two DB columns, putting the
 * empty-string sentinel '' on the unused side. A skill grant is
 * `(skill_id='x', connector_id='')`; a connector grant is the mirror. Keeping
 * BOTH columns in every WHERE clause is what makes a skill `linear` grant and a
 * connector `linear` grant non-colliding.
 */
function subjectColumns(subject: ApprovedCapSubject): {
  skill_id: string;
  connector_id: string;
} {
  if ('connectorId' in subject) {
    return { skill_id: '', connector_id: subject.connectorId };
  }
  return { skill_id: subject.skillId, connector_id: '' };
}

export function createApprovedCapsStore(db: Kysely<SkillsDatabase>): ApprovedCapsStore {
  return {
    async set({ ownerUserId, agentId, kind, value, detail, ...subject }) {
      const { skill_id, connector_id } = subjectColumns(subject as ApprovedCapSubject);
      // Idempotent: a duplicate (kind, value) for the same subject is a no-op.
      // Accept the PK-violation race (mirrors host-grants / quarantine).
      const res = await db
        .insertInto('skills_v1_approved_caps')
        .values({
          owner_user_id: ownerUserId,
          agent_id: agentId,
          skill_id,
          connector_id,
          cap_kind: kind,
          cap_value: value,
          cap_detail: detail === undefined ? null : (detail as unknown),
          created_at: new Date(),
        })
        .onConflict((oc) =>
          oc
            .columns([
              'owner_user_id',
              'agent_id',
              'skill_id',
              'connector_id',
              'cap_kind',
              'cap_value',
            ])
            .doNothing(),
        )
        .executeTakeFirst();
      return { created: Number(res.numInsertedOrUpdatedRows ?? 0n) > 0 };
    },

    async clear({ ownerUserId, agentId, kind, value, ...subject }) {
      const { skill_id, connector_id } = subjectColumns(subject as ApprovedCapSubject);
      const res = await db
        .deleteFrom('skills_v1_approved_caps')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skill_id)
        .where('connector_id', '=', connector_id)
        .where('cap_kind', '=', kind)
        .where('cap_value', '=', value)
        .executeTakeFirst();
      return { cleared: Number(res.numDeletedRows ?? 0n) > 0 };
    },

    async list({ ownerUserId, agentId, ...subject }) {
      const { skill_id, connector_id } = subjectColumns(subject as ApprovedCapSubject);
      const rows = await db
        .selectFrom('skills_v1_approved_caps')
        .select(['cap_kind', 'cap_value'])
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skill_id)
        .where('connector_id', '=', connector_id)
        .orderBy('cap_kind', 'asc')
        .orderBy('cap_value', 'asc')
        .execute();
      return rows.map((r) => ({ kind: r.cap_kind as ApprovedCapKind, value: r.cap_value }));
    },
  };
}
