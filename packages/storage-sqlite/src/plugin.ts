import { PluginError, type Plugin } from '@ax/core';
import { openDatabase, type Database } from './schema.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z, type ZodType } from 'zod';

const PLUGIN_NAME = '@ax/storage-sqlite';

export interface StorageSqliteConfig {
  databasePath: string;
}

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

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the data-returning `storage:*` hooks
// (ARCH-13). `storage:set` and `db:transact` return `void`, so they get no
// schema (nothing to validate). The kv contract is `{ key, value: Uint8Array }`
// — opaque bytes, no backend vocab (Invariant 1; @ax/storage-postgres carries a
// structurally-identical copy, the I2 two-backend pattern). `z.instanceof(
// Uint8Array)` accepts the Uint8Array the handler exposes at the edge (it wraps
// the raw row buffer in `new Uint8Array(...)`). The drift-guard
// `return-schemas.test.ts` round-trips a populated value and asserts the bytes
// survive by reference.
// ---------------------------------------------------------------------------
export const StorageGetOutputSchema = z.object({
  value: z.instanceof(Uint8Array).optional(),
}) as unknown as ZodType<{ value: Uint8Array | undefined }>;

export const StorageListPrefixOutputSchema = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.instanceof(Uint8Array) })),
});

export const StorageDeletePrefixOutputSchema = z.object({
  deleted: z.number(),
});

export function createStorageSqlitePlugin(config: StorageSqliteConfig): Plugin {
  let db: Kysely<Database> | undefined;

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
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      db = openDatabase(config.databasePath);

      bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        PLUGIN_NAME,
        async (_ctx, { key }) => {
          const row = await db!
            .selectFrom('kv')
            .select('value')
            .where('key', '=', key)
            .executeTakeFirst();
          if (row === undefined) return { value: undefined };
          return { value: new Uint8Array(row.value) };
        },
        { returns: StorageGetOutputSchema },
      );

      bus.registerService<StorageSetInput, void>(
        'storage:set',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const { key, value } = input;
          const exec = (input.tx ?? db!) as Kysely<Database>;
          await exec
            .insertInto('kv')
            .values({ key, value: Buffer.from(value) })
            .onConflict((oc) =>
              oc.column('key').doUpdateSet({
                value: Buffer.from(value),
                updated_at: new Date().toISOString(),
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
        // Escape SQL-LIKE meta-characters (% and _ and \) so a literal
        // prefix doesn't accidentally match glob-like keys. The ESCAPE
        // clause tells SQLite that '\' precedes literal meta-chars.
        const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        const rows = await db!
          .selectFrom('kv')
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
            .deleteFrom('kv')
            .where(sql<boolean>`key LIKE ${escaped + '%'} ESCAPE '\\'`)
            .executeTakeFirst();
          return { deleted: Number(result.numDeletedRows ?? 0) };
        },
        { returns: StorageDeletePrefixOutputSchema },
      );
    },
    async shutdown() {
      if (db !== undefined) {
        await db.destroy().catch(() => {
          // best-effort; better-sqlite3's close is sync but Kysely wraps it.
        });
        db = undefined;
      }
    },
  };
}
