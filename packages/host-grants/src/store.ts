/**
 * @ax/host-grants store. Every query is scoped to (owner_user_id, agent_id):
 * the scope-isolation boundary — user A's queries MUST NEVER touch user B's
 * rows, and agent a1's grants never bleed into a2.
 */
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { HostGrantsDatabase } from './migrations.js';
import { assertValidHost } from './host-validate.js';

const PLUGIN_NAME = '@ax/host-grants';
const MAX_GRANTS_PER_AGENT = 256;

export interface HostGrant {
  host: string;
  /** ISO-8601 grant timestamp. Surfaced by the settings mirror (TASK-42). */
  grantedAt: string;
}

export interface HostGrantsStore {
  grant(input: { ownerUserId: string; agentId: string; host: string }): Promise<{ created: boolean }>;
  list(ownerUserId: string, agentId: string): Promise<HostGrant[]>;
  revoke(input: { ownerUserId: string; agentId: string; host: string }): Promise<{ revoked: boolean }>;
}

export function createHostGrantsStore(db: Kysely<HostGrantsDatabase>): HostGrantsStore {
  return {
    async grant({ ownerUserId, agentId, host }) {
      assertValidHost(host);
      // Idempotent: an existing host is a no-op and never counts against the cap.
      const existing = await db
        .selectFrom('host_grants_v1_grants')
        .select('host')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('host', '=', host)
        .executeTakeFirst();
      if (existing !== undefined) return { created: false };

      const { count } = await db
        .selectFrom('host_grants_v1_grants')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_GRANTS_PER_AGENT) {
        throw new PluginError({
          code: 'grant-limit',
          plugin: PLUGIN_NAME,
          message: `at most ${MAX_GRANTS_PER_AGENT} host grants per (user, agent)`,
        });
      }

      // Accepted race (mirrors @ax/skills user-attachments-store): a concurrent
      // insert of the same compound key surfaces as a PK violation, fine at
      // user scale.
      await db
        .insertInto('host_grants_v1_grants')
        .values({ owner_user_id: ownerUserId, agent_id: agentId, host, created_at: new Date() })
        .execute();
      return { created: true };
    },

    async list(ownerUserId, agentId) {
      const rows = await db
        .selectFrom('host_grants_v1_grants')
        .select(['host', 'created_at'])
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .orderBy('host', 'asc')
        .execute();
      return rows.map((r) => ({ host: r.host, grantedAt: r.created_at.toISOString() }));
    },

    async revoke({ ownerUserId, agentId, host }) {
      const res = await db
        .deleteFrom('host_grants_v1_grants')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('host', '=', host)
        .executeTakeFirst();
      return { revoked: Number(res.numDeletedRows ?? 0n) > 0 };
    },
  };
}
