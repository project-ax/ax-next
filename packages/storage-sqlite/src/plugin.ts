import { PluginError, type Plugin } from '@ax/core';
import { openDatabase, type Database } from './schema.js';
import { sql, type Kysely, type Transaction } from 'kysely';

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

export function createStorageSqlitePlugin(config: StorageSqliteConfig): Plugin {
  let db: Kysely<Database> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['storage:get', 'storage:set', 'storage:list-prefix', 'db:transact'],
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
      });
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
