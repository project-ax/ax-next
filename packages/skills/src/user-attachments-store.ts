/**
 * @ax/skills per-(user, agent) attachment store.
 *
 * Self-serve layer above the admin-managed agent-global attachments owned by
 * @ax/agents. Every query is scoped to (owner_user_id, agent_id): this is the
 * scope-isolation boundary — user A's queries MUST NEVER touch user B's rows,
 * and agent a1's attachments never bleed into a2.
 *
 * credential_bindings is JSONB: written via JSON.stringify (matching the
 * @ax/agents skill_attachments precedent), read back as a parsed object by
 * node-postgres.
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';

export interface UserAttachment {
  skillId: string;
  /** slot → opaque credential ref (the user's own credential). Never a secret. */
  credentialBindings: Record<string, string>;
}

export interface UpsertUserAttachmentInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  credentialBindings: Record<string, string>;
}

export interface UserAttachmentsStore {
  /** Upsert one attachment. Returns { created: true } on insert, false on update. */
  upsert(input: UpsertUserAttachmentInput): Promise<{ created: boolean }>;
  /** List a user's attachments on one agent, ordered by skill_id (deterministic). */
  listForUserAgent(ownerUserId: string, agentId: string): Promise<UserAttachment[]>;
}

export function createUserAttachmentsStore(
  db: Kysely<SkillsDatabase>,
): UserAttachmentsStore {
  return {
    async upsert(input) {
      // SELECT → INSERT or UPDATE so `created` is accurate. Accepted race
      // mirrors user-store.ts: a concurrent insert of the same compound key
      // surfaces as a PRIMARY KEY violation, acceptable at user scale. The
      // compound PRIMARY KEY (owner_user_id, agent_id, skill_id) guards the
      // unique pair.
      const existing = await db
        .selectFrom('skills_v1_user_attachments')
        .select('skill_id')
        .where('owner_user_id', '=', input.ownerUserId)
        .where('agent_id', '=', input.agentId)
        .where('skill_id', '=', input.skillId)
        .executeTakeFirst();

      if (existing === undefined) {
        const now = new Date();
        await db
          .insertInto('skills_v1_user_attachments')
          .values({
            owner_user_id: input.ownerUserId,
            agent_id: input.agentId,
            skill_id: input.skillId,
            credential_bindings: JSON.stringify(input.credentialBindings) as unknown,
            created_at: now,
            updated_at: now,
          })
          .execute();
        return { created: true };
      }

      await db
        .updateTable('skills_v1_user_attachments')
        .set({
          credential_bindings: JSON.stringify(input.credentialBindings) as unknown,
          updated_at: new Date(),
        })
        .where('owner_user_id', '=', input.ownerUserId)
        .where('agent_id', '=', input.agentId)
        .where('skill_id', '=', input.skillId)
        .execute();
      return { created: false };
    },

    async listForUserAgent(ownerUserId, agentId) {
      const rows = await db
        .selectFrom('skills_v1_user_attachments')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .orderBy('skill_id', 'asc')
        .execute();

      return rows.map((r) => ({
        skillId: r.skill_id,
        credentialBindings: (r.credential_bindings ?? {}) as Record<string, string>,
      }));
    },
  };
}
