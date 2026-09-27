import { makeAgentContext, type Plugin } from '@ax/core';

// ---------------------------------------------------------------------------
// TASK-608 — drop the retired Strata search-index tables.
//
// Strata memory (@ax/memory-strata + @ax/memory-strata-index-postgres) was
// deleted once facts memory became the default. Its postgres index kept a COPY
// of every agent's old memory text in `memory_strata_index_v2_docs` (and the
// pre-TASK-186 pooled `memory_strata_index_v1_docs`, orphaned since). The
// plugin that created them is gone, so nothing would ever drop them: the text
// would sit in the database forever with no reader.
//
// The preset that wired the index owns its cleanup. `DROP TABLE IF EXISTS` is
// idempotent — a fresh database, or one the operator already cleaned with the
// deploy/README.md runbook, is a no-op — and it takes each table's indexes
// with it. It runs on every boot for the same reason @ax/conversations drops
// `conversations_v1_turns` on every boot: one cheap statement beats a marker.
//
// No hook is registered: this is a one-way migration, not a service.
// ---------------------------------------------------------------------------

export const RETIRE_STRATA_INDEX_PLUGIN_NAME = '@ax/preset-k8s/retire-strata-index';

/** The tables dropped, in order. Exported so the tests assert the same list. */
export const RETIRED_STRATA_INDEX_TABLES = Object.freeze([
  'memory_strata_index_v2_docs',
  'memory_strata_index_v1_docs',
] as const);

/**
 * The slice of the shared Kysely instance this plugin uses. Structural on
 * purpose: `database:get-instance` hands back `Kysely<unknown>`, and naming
 * only `schema.dropTable(...).ifExists().execute()` keeps kysely a dev-only
 * dependency of this preset.
 */
interface DropTableDb {
  schema: {
    dropTable(name: string): {
      ifExists(): { execute(): Promise<unknown> };
    };
  };
}

export function createRetireStrataIndexPlugin(): Plugin {
  return {
    manifest: {
      name: RETIRE_STRATA_INDEX_PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['database:get-instance'],
      subscribes: [],
    },
    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: RETIRE_STRATA_INDEX_PLUGIN_NAME,
        userId: 'system',
      });
      const { db } = await bus.call<unknown, { db: DropTableDb }>(
        'database:get-instance',
        initCtx,
        {},
      );
      // A failure here throws out of init and fails the boot. That is the
      // loud outcome we want: a database that refuses a DROP TABLE IF EXISTS
      // is not one the rest of the host would run well on either.
      for (const table of RETIRED_STRATA_INDEX_TABLES) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  };
}
