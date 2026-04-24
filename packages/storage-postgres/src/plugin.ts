import { makeChatContext, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runStorageMigration, type StorageDatabase } from './migrations.js';

/**
 * @ax/storage-postgres — postgres-backed peer of @ax/storage-sqlite.
 *
 * Same hook contract; different backend. Uses the shared Kysely instance
 * owned by @ax/database-postgres via `database:get-instance`. Per
 * Invariant 2, this plugin does NOT direct-import @ax/database-postgres
 * at runtime — the bus is the only inter-plugin API.
 */

const PLUGIN_NAME = '@ax/storage-postgres';

export function createStoragePostgresPlugin(): Plugin {
  let db: Kysely<StorageDatabase> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: ['database:get-instance'],
      subscribes: [],
    },
    async init({ bus }) {
      // bootstrap()'s topological order ensures database-postgres has
      // already registered `database:get-instance` before we run.
      // No caller ChatContext at init-time — synthesize one with
      // makeChatContext(). The init context is purely for log correlation;
      // the underlying handler ignores it.
      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      // The bus contract is `Kysely<unknown>`; we cast at the edge to our
      // own typed schema. The shared instance ITSELF is just a Kysely
      // wrapped around a pg.Pool — the type parameter is purely a
      // compile-time witness for which tables exist, and our
      // table-prefix namespace (`storage_postgres_v1_*`) is owned by us.
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<StorageDatabase>;
      await runStorageMigration(db);

      bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        PLUGIN_NAME,
        async (_ctx, { key }) => {
          const row = await db!
            .selectFrom('storage_postgres_v1_kv')
            .select('value')
            .where('key', '=', key)
            .executeTakeFirst();
          if (row === undefined) return { value: undefined };
          // pg returns BYTEA as Buffer; expose as Uint8Array at the edge.
          return { value: new Uint8Array(row.value) };
        },
      );

      bus.registerService<{ key: string; value: Uint8Array }, void>(
        'storage:set',
        PLUGIN_NAME,
        async (_ctx, { key, value }) => {
          // Buffer.from(Uint8Array) shares the underlying memory, so this
          // doesn't copy. Kysely's pg dialect serializes Buffer → BYTEA.
          const buf = Buffer.from(value);
          await db!
            .insertInto('storage_postgres_v1_kv')
            .values({ key, value: buf, updated_at: new Date() })
            .onConflict((oc) =>
              oc.column('key').doUpdateSet({
                value: buf,
                updated_at: new Date(),
              }),
            )
            .execute();
        },
      );
    },
  };
}
