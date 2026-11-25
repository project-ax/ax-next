/**
 * @ax/host-grants store. An agent's allowed sites belong to the agent
 * (TASK-1212). `owner_user_id` records who added a row. Every writer checks
 * access to the agent first, so on a personal agent only its owners add, and
 * on a shared personal agent anyone who can use it does (TASK-1248). On a
 * team agent the list is every member's adds, one entry per host.
 *
 * So `list`, `revoke`, the duplicate check and the cap are keyed by agent, and
 * agent a1's sites never bleed into a2. `listForUser` is the one read keyed by
 * the adder: the rows that person added, across their agents. This store
 * checks no ACL; its callers do (see plugin.ts).
 */
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { HostGrantsDatabase } from './migrations.js';
import { assertValidHost } from './host-validate.js';

const PLUGIN_NAME = '@ax/host-grants';
/**
 * At most this many distinct hosts per agent, whoever added them. It bounds a
 * session's egress allowlist, so on a team agent every member shares it.
 */
const MAX_GRANTS_PER_AGENT = 256;

export interface HostGrant {
  host: string;
  /** ISO-8601 grant timestamp. Surfaced by the settings mirror (TASK-42). */
  grantedAt: string;
}

/** A grant as seen ACROSS the user's agents — carries `agentId` because the
 *  Settings "Allowed sites" surface lists each host once and shows which agents
 *  it applies to. */
export interface HostGrantForUser extends HostGrant {
  agentId: string;
}

export interface HostGrantsStore {
  /**
   * Keep `host` on the agent; `ownerUserId` is the person adding it. A host the
   * agent already has, whoever added it, is a no-op (`created: false`) and is
   * never limited. Otherwise throws `grant-limit` once the agent has
   * MAX_GRANTS_PER_AGENT distinct hosts.
   */
  grant(input: { ownerUserId: string; agentId: string; host: string }): Promise<{ created: boolean }>;
  /** The agent's sites: one entry per host whoever added it, with the earliest
   *  `grantedAt`, ordered by host. */
  list(agentId: string): Promise<HostGrant[]>;
  /** Every row the user added across ALL their agents (each row carries its
   *  agentId), ordered host asc then agentId asc. Adder-scoped — another
   *  user's rows are never returned. Backs the Settings one-list view. */
  listForUser(ownerUserId: string): Promise<HostGrantForUser[]>;
  /** Take `host` off the agent for everyone: deletes every adder's row for it. */
  revoke(input: { agentId: string; host: string }): Promise<{ revoked: boolean }>;
  /**
   * Delete EVERY grant for `agentId`, whoever added it (TASK-718). Backs the
   * `agents:deleted` subscriber. Throws on an empty `agentId` — a delete must
   * never run with an empty key.
   */
  deleteAllForAgent(agentId: string): Promise<{ deleted: number }>;
}

export function createHostGrantsStore(db: Kysely<HostGrantsDatabase>): HostGrantsStore {
  return {
    async grant({ ownerUserId, agentId, host }) {
      assertValidHost(host);
      // Idempotent: a host the agent already has, whoever added it, is a no-op
      // and never counts against the cap — so this check runs before the cap's.
      const existing = await db
        .selectFrom('host_grants_v1_grants')
        .select('host')
        .where('agent_id', '=', agentId)
        .where('host', '=', host)
        .executeTakeFirst();
      if (existing !== undefined) return { created: false };

      // Distinct hosts, not rows: a host two people added counts once.
      const { count } = await db
        .selectFrom('host_grants_v1_grants')
        .select((eb) => eb.fn.count<number>('host').distinct().as('count'))
        .where('agent_id', '=', agentId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_GRANTS_PER_AGENT) {
        throw new PluginError({
          code: 'grant-limit',
          plugin: PLUGIN_NAME,
          message: `at most ${MAX_GRANTS_PER_AGENT} host grants per agent`,
        });
      }

      // Accepted races (mirrors @ax/skills user-attachments-store), fine at
      // user scale. The same person adding one host twice at once surfaces as
      // a PK violation. Two people adding one host at once may leave two rows:
      // harmless, because reads group by host and revoke deletes every row for
      // it. Concurrent adds of different hosts can overshoot the cap by a few.
      await db
        .insertInto('host_grants_v1_grants')
        .values({ owner_user_id: ownerUserId, agent_id: agentId, host, created_at: new Date() })
        .execute();
      return { created: true };
    },

    async list(agentId) {
      // One entry per host: a host added by two people (at once, or before
      // TASK-1212) reads as one site, granted when it was first added.
      const rows = await db
        .selectFrom('host_grants_v1_grants')
        .select((eb) => ['host', eb.fn.min('created_at').as('granted_at')])
        .where('agent_id', '=', agentId)
        .groupBy('host')
        .orderBy('host', 'asc')
        .execute();
      return rows.map((r) => ({ host: r.host, grantedAt: r.granted_at.toISOString() }));
    },

    async listForUser(ownerUserId) {
      const rows = await db
        .selectFrom('host_grants_v1_grants')
        .select(['host', 'agent_id', 'created_at'])
        .where('owner_user_id', '=', ownerUserId)
        .orderBy('host', 'asc')
        .orderBy('agent_id', 'asc')
        .execute();
      return rows.map((r) => ({
        host: r.host,
        agentId: r.agent_id,
        grantedAt: r.created_at.toISOString(),
      }));
    },

    async revoke({ agentId, host }) {
      // Every adder's row for the host: the site leaves the agent for everyone.
      const res = await db
        .deleteFrom('host_grants_v1_grants')
        .where('agent_id', '=', agentId)
        .where('host', '=', host)
        .executeTakeFirst();
      return { revoked: Number(res.numDeletedRows ?? 0n) > 0 };
    },

    async deleteAllForAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new PluginError({
          code: 'missing-field',
          plugin: PLUGIN_NAME,
          message: 'agentId is required',
        });
      }
      const res = await db
        .deleteFrom('host_grants_v1_grants')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return { deleted: Number(res.numDeletedRows ?? 0n) };
    },
  };
}
