import type { Plugin } from '@ax/core';
import { openDatabase, type Database } from './schema.js';
import type { Kysely } from 'kysely';

const PLUGIN_NAME = '@ax/storage-sqlite';

export interface StorageSqliteConfig {
  databasePath: string;
}

export function createStorageSqlitePlugin(config: StorageSqliteConfig): Plugin {
  let db: Kysely<Database> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
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

      bus.registerService<{ key: string; value: Uint8Array }, void>(
        'storage:set',
        PLUGIN_NAME,
        async (_ctx, { key, value }) => {
          await db!
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
    },
  };
}
