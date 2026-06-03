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
      subscribes: [],
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
      store = createHostGrantsStore(typed);

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
          hosts: await store!.list(
            requireField(input.ownerUserId, 'ownerUserId'),
            requireField(input.agentId, 'agentId'),
          ),
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
            ownerUserId: requireField(input.ownerUserId, 'ownerUserId'),
            agentId: requireField(input.agentId, 'agentId'),
            host: input.host,
          }),
        { returns: HostGrantsRevokeOutputSchema },
      );
    },
  };
}
