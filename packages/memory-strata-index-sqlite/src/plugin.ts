import { PluginError, type Plugin } from '@ax/core';
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

// Hard upper bound on `topK`. Above this, FTS5's per-row scoring cost
// grows without surfacing additional useful results — and `LIMIT -1` in
// SQLite means unbounded, so a non-positive topK is a real risk to clamp.
//
// The same constant is duplicated in @ax/memory-strata-index-postgres —
// CLAUDE.md invariant 2 forbids runtime cross-plugin imports, even for
// pure constants. Drift is caught by the shared contract test
// (`runIndexContract`'s "clamps topK above MAX_TOP_K" case).
const MAX_TOP_K = 50;

function validateSearchInput(input: SearchInput): { topK: number } {
  if (typeof input.query !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'query must be a string',
    });
  }
  if (
    typeof input.topK !== 'number' ||
    !Number.isFinite(input.topK) ||
    input.topK < 1
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'topK must be a positive number',
    });
  }
  if (
    input.categoryFilter !== undefined &&
    typeof input.categoryFilter !== 'string'
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'categoryFilter must be a string when set',
    });
  }
  return { topK: Math.min(Math.floor(input.topK), MAX_TOP_K) };
}

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
          const { topK } = validateSearchInput(input);
          const results = await search(db!, input.query, topK, input.categoryFilter);
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
