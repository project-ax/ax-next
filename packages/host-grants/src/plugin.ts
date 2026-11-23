/**
 * @ax/host-grants — the websites each agent may always reach (its kept
 * "always allow" egress hosts). An agent's sites belong to the agent
 * (TASK-1212): `host-grants:list` and `host-grants:revoke` are keyed by agent,
 * so on a team agent one person's Allow covers every member, and one Remove
 * takes the site off for everyone. `host-grants:grant`'s `ownerUserId` is the
 * person adding it; `host-grants:list-for-user` lists the rows that person
 * added.
 *
 * Callers' contract: host-grants checks no ACL. Before `host-grants:grant`, a
 * caller proves the person may use the agent; before `host-grants:revoke`, that
 * they may manage it. Each writer gating on the agent's own ACL is what keeps a
 * personal agent's list its owner's.
 */
import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runHostGrantsMigration, type HostGrantsDatabase } from './migrations.js';
import { createHostGrantsStore, type HostGrantsStore } from './store.js';
import {
  HostGrantsGrantOutputSchema,
  HostGrantsListOutputSchema,
  HostGrantsListForUserOutputSchema,
  HostGrantsRevokeOutputSchema,
  type HostGrantsGrantInput,
  type HostGrantsGrantOutput,
  type HostGrantsListInput,
  type HostGrantsListOutput,
  type HostGrantsListForUserInput,
  type HostGrantsListForUserOutput,
  type HostGrantsRevokeInput,
  type HostGrantsRevokeOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/host-grants';

function requireField(value: string | undefined, name: string): string {
  if (!value) {
    throw new PluginError({
      code: 'missing-field',
      plugin: PLUGIN_NAME,
      message: `${name} is required`,
    });
  }
  return value;
}

export function createHostGrantsPlugin(): Plugin {
  let store: HostGrantsStore | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'host-grants:grant',
        'host-grants:list',
        'host-grants:list-for-user',
        'host-grants:revoke',
      ],
      calls: ['database:get-instance'],
      // TASK-718: `@ax/agents` fires this after the agent row is gone; the
      // grants table has no FK to it, so this subscriber is the only cleanup.
      subscribes: ['agents:deleted'],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      const typed = db as Kysely<HostGrantsDatabase>;
      await runHostGrantsMigration(typed);
      const localStore = createHostGrantsStore(typed);
      store = localStore;

      // TASK-718 — a deleted agent's grants must go with it. Payload (declared
      // locally, no cross-plugin import): `{ agentId, ownerId, ownerType }`;
      // only `agentId` matters, the same key as list and revoke, because a
      // team agent's sites were added by several members. K10: a subscriber
      // must never throw — a failed purge is logged loudly and swallowed.
      bus.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          ctx.logger.warn('host_grants_purge_for_deleted_agent_skipped', {
            reason: 'agents:deleted payload has no non-empty string agentId',
          });
          return undefined;
        }
        try {
          const { deleted } = await localStore.deleteAllForAgent(agentId);
          ctx.logger.info('host_grants_purged_for_deleted_agent', { agentId, deleted });
        } catch (err) {
          ctx.logger.error('host_grants_purge_for_deleted_agent_failed', { agentId, err });
        }
        return undefined;
      });

      bus.registerService<HostGrantsGrantInput, HostGrantsGrantOutput>(
        'host-grants:grant',
        PLUGIN_NAME,
        async (_ctx, input) =>
          store!.grant({
            ownerUserId: requireField(input.ownerUserId, 'ownerUserId'),
            agentId: requireField(input.agentId, 'agentId'),
            host: input.host,
          }),
        { returns: HostGrantsGrantOutputSchema },
      );

      bus.registerService<HostGrantsListInput, HostGrantsListOutput>(
        'host-grants:list',
        PLUGIN_NAME,
        async (_ctx, input) => ({
          hosts: await store!.list(requireField(input.agentId, 'agentId')),
        }),
        { returns: HostGrantsListOutputSchema },
      );

      bus.registerService<HostGrantsListForUserInput, HostGrantsListForUserOutput>(
        'host-grants:list-for-user',
        PLUGIN_NAME,
        async (_ctx, input) => ({
          grants: await store!.listForUser(requireField(input.ownerUserId, 'ownerUserId')),
        }),
        { returns: HostGrantsListForUserOutputSchema },
      );

      bus.registerService<HostGrantsRevokeInput, HostGrantsRevokeOutput>(
        'host-grants:revoke',
        PLUGIN_NAME,
        async (_ctx, input) =>
          store!.revoke({
            agentId: requireField(input.agentId, 'agentId'),
            host: input.host,
          }),
        { returns: HostGrantsRevokeOutputSchema },
      );
    },
  };
}
