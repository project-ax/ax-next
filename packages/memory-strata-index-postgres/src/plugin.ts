import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import { type Kysely } from 'kysely';
import { runIndexMigration, type MemoryStrataIndexDatabase } from './migrations.js';
import { upsert, search, deleteOne, clearAll } from './queries.js';
import type {
  UpsertInput,
  SearchInput,
  SearchOutput,
  DeleteInput,
} from '@ax/memory-strata-index-contract';

// Hard upper bound on `topK`. Postgres tsvector queries scale with the
// result set; clamping protects against runaway costly queries.
//
// The same constant is duplicated in @ax/memory-strata-index-sqlite —
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

/**
 * @ax/memory-strata-index-postgres — postgres-backed peer of
 * @ax/memory-strata-index-sqlite.
 *
 * Same four hook contract; different backend. Uses the shared Kysely instance
 * owned by @ax/database-postgres via `database:get-instance`. Per Invariant 2,
 * this plugin does NOT direct-import @ax/database-postgres at runtime — the
 * bus is the only inter-plugin API.
 *
 * Search is powered by Postgres tsvector + GIN index with ts_rank scoring:
 *   summary (weight A) > headers (weight B) > body (weight C)
 * plainto_tsquery handles safe parameterization natively.
 */

const PLUGIN_NAME = '@ax/memory-strata-index-postgres';

export function createMemoryStrataIndexPostgresPlugin(): Plugin {
  let db: Kysely<MemoryStrataIndexDatabase> | undefined;

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
      calls: ['database:get-instance'],
      subscribes: [],
    },

    async init({ bus }) {
      // bootstrap()'s topological order ensures database-postgres has already
      // registered `database:get-instance` before we run. Synthesize an init
      // context for log correlation; the underlying handler ignores it.
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      // The bus contract is Kysely<unknown>; we cast at the edge to our typed
      // schema. The shared instance IS just a Kysely<pg.Pool> — the type param
      // is a compile-time witness for which tables exist, namespaced by our
      // `memory_strata_index_v1_*` prefix.
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<MemoryStrataIndexDatabase>;
      await runIndexMigration(db);

      bus.registerService<UpsertInput, void>(
        'memory:index:upsert',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (typeof input.docId !== 'string' || input.docId.length === 0) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'docId is required',
            });
          }
          await upsert(db!, input);
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
          if (typeof input.docId !== 'string' || input.docId.length === 0) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'docId is required',
            });
          }
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

    // NO shutdown() — the shared Kysely instance is owned and destroyed by
    // @ax/database-postgres. Calling db.destroy() here would tear down the
    // pool for all other postgres-backed plugins.
  };
}
