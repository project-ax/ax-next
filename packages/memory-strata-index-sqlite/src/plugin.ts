import type { Plugin } from '@ax/core';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { type Kysely } from 'kysely';
import { openDatabase, type Database } from './schema.js';
import { upsert, search, deleteOne, clearAll } from './queries.js';
import type {
  UpsertInput,
  SearchInput,
  SearchOutput,
  DeleteInput,
} from '@ax/memory-strata-index-contract';

const PLUGIN_NAME = '@ax/memory-strata-index-sqlite';

export interface MemoryStrataIndexSqliteConfig {
  databasePath: string;
}

export function createMemoryStrataIndexSqlitePlugin(
  config: MemoryStrataIndexSqliteConfig,
): Plugin {
  let db: Kysely<Database> | undefined;
  let rawDriver: BetterSqliteDb | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'memory:index:upsert',
        'memory:index:search',
        'memory:index:delete',
        'memory:index:clear',
      ],
      calls: [],
      subscribes: [],
    },

    init({ bus }) {
      const opened = openDatabase(config.databasePath);
      db = opened.db;
      rawDriver = opened.rawDriver;

      bus.registerService<UpsertInput, void>(
        'memory:index:upsert',
        PLUGIN_NAME,
        async (_ctx, input) => {
          upsert(rawDriver!, input);
        },
      );

      bus.registerService<SearchInput, SearchOutput>(
        'memory:index:search',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const results = await search(db!, input.query, input.topK, input.categoryFilter);
          return { results };
        },
      );

      bus.registerService<DeleteInput, void>(
        'memory:index:delete',
        PLUGIN_NAME,
        async (_ctx, input) => {
          await deleteOne(db!, input.docId);
        },
      );

      bus.registerService<Record<string, never>, void>(
        'memory:index:clear',
        PLUGIN_NAME,
        async (_ctx, _input) => {
          await clearAll(db!);
        },
      );
    },

    async shutdown() {
      if (db !== undefined) {
        await db.destroy().catch(() => {
          // best-effort; better-sqlite3's close is sync but Kysely wraps it.
        });
        db = undefined;
        rawDriver = undefined;
      }
    },
  };
}
