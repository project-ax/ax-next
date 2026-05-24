import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z, type ZodType } from 'zod';
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

export interface DbTransactInput {
  run: (args: { tx: Transaction<unknown> }) => Promise<void>;
}
export type DbTransactOutput = void;

export interface StorageSetInput {
  key: string;
  value: Uint8Array;
  /** Optional transaction handle from db:transact's run callback. */
  tx?: Transaction<unknown>;
}

// Runtime `returns` contracts for the data-returning `storage:*` hooks
// (ARCH-13). Structurally identical to @ax/storage-sqlite's copy (the I2
// two-backend pattern); `storage:set` / `db:transact` return `void` and so get
// no schema. The kv contract is opaque bytes (`Uint8Array`), no backend vocab.
export const StorageGetOutputSchema = z.object({
  value: z.instanceof(Uint8Array).optional(),
}) as unknown as ZodType<{ value: Uint8Array | undefined }>;

export const StorageListPrefixOutputSchema = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.instanceof(Uint8Array) })),
});

export const StorageDeletePrefixOutputSchema = z.object({
  deleted: z.number(),
});

export function createStoragePostgresPlugin(): Plugin {
  let db: Kysely<StorageDatabase> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'storage:get',
        'storage:set',
        'storage:list-prefix',
        'storage:delete-prefix',
        'db:transact',
      ],
      calls: ['database:get-instance'],
      subscribes: [],
    },
    async init({ bus }) {
      // bootstrap()'s topological order ensures database-postgres has
      // already registered `database:get-instance` before we run.
      // No caller AgentContext at init-time — synthesize one with
      // makeAgentContext(). The init context is purely for log correlation;
      // the underlying handler ignores it.
      const initCtx = makeAgentContext({
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
        { returns: StorageGetOutputSchema },
      );

      bus.registerService<StorageSetInput, void>(
        'storage:set',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const { key, value } = input;
          // Buffer.from(Uint8Array) shares the underlying memory, so this
          // doesn't copy. Kysely's pg dialect serializes Buffer → BYTEA.
          const buf = Buffer.from(value);
          const exec = (input.tx ?? db!) as Kysely<StorageDatabase>;
          await exec
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

      // I1 caveat: this hook leaks Kysely's `Transaction` shape into
      // payloads. Accepted because the alternatives (async-local-storage
      // magic; opaque tx tokens) are either implicit or require a registry
      // that itself has cross-plugin coordination. Used by Phase 2's
      // wizard completion transaction (credential + agent + bootstrap).
      bus.registerService<DbTransactInput, DbTransactOutput>(
        'db:transact',
        PLUGIN_NAME,
        async (_ctx, input) => {
          await db!.transaction().execute(async (trx) => {
            await input.run({ tx: trx as Transaction<unknown> });
          });
        },
      );

      bus.registerService<
        { prefix: string },
        { entries: Array<{ key: string; value: Uint8Array }> }
      >('storage:list-prefix', PLUGIN_NAME, async (_ctx, { prefix }) => {
        if (typeof prefix !== 'string' || prefix.length === 0) {
          throw new PluginError({
            code: 'invalid-payload',
            plugin: PLUGIN_NAME,
            message: 'prefix is required',
          });
        }
        // Escape SQL-LIKE meta-characters so a literal prefix doesn't
        // glob-match. ESCAPE clause tells Postgres '\' is the escape.
        const escaped = prefix
          .replace(/\\/g, '\\\\')
          .replace(/%/g, '\\%')
          .replace(/_/g, '\\_');
        const rows = await db!
          .selectFrom('storage_postgres_v1_kv')
          .select(['key', 'value'])
          .where(sql<boolean>`key LIKE ${escaped + '%'} ESCAPE '\\'`)
          .execute();
        return {
          entries: rows.map((r) => ({ key: r.key, value: new Uint8Array(r.value) })),
        };
      }, { returns: StorageListPrefixOutputSchema });

      bus.registerService<{ prefix: string }, { deleted: number }>(
        'storage:delete-prefix',
        PLUGIN_NAME,
        async (_ctx, { prefix }) => {
          if (typeof prefix !== 'string' || prefix.length === 0) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'prefix is required',
            });
          }
          const escaped = prefix
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_');
          const result = await db!
            .deleteFrom('storage_postgres_v1_kv')
            .where(sql<boolean>`key LIKE ${escaped + '%'} ESCAPE '\\'`)
            .executeTakeFirst();
          return { deleted: Number(result.numDeletedRows ?? 0) };
        },
        { returns: StorageDeletePrefixOutputSchema },
      );
    },
  };
}
