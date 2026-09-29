import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { PluginError } from '@ax/core';
import { TABLE, deleteIndexedFactRows } from './schema.js';
import { agentScopeKeyForAgentId } from './agent-scope-key.js';

const PLUGIN_NAME = '@ax/memory-facts-sqlite';

/**
 * Delete EVERY row this engine holds for one scope key — the base rows (closed
 * history included) AND the derived FTS5/vec0 rows built from their text — in
 * ONE transaction, and say how many base rows went.
 *
 * The one place "forget this partition" is spelled, shared by
 * `memory:facts:clear` (the calling agent forgets) and the `agents:deleted`
 * purge (the agent no longer exists), so the two cannot drift into forgetting
 * different things (Invariant 4).
 *
 * The derived rows go in the same transaction, and BEFORE the base rows (their
 * ids are read from the base table). Everywhere else the FTS shadow is left
 * alone when a fact stops being current — that is a VALIDITY question and the
 * base table is its sole authority, so the join at query time settles it. This
 * is not a validity question: the base row is gone, so the join would hide the
 * text either way, and leaving the tenant's statements sitting in a shadow
 * table after they asked us to forget them (or after the agent was deleted) is
 * a retention bug rather than a ranking one.
 *
 * `memory_facts_v1` is the only table here with an `agent_key` column. The
 * shadow tables are keyed by fact id, and `memory_facts_v1_embedding_meta`
 * holds one store-wide fingerprint, so neither carries a tenant.
 */
export function deleteFactsForKey(
  db: BetterSqliteDb,
  agentKey: string,
  vectorExtensionLoaded: boolean,
): number {
  const forget = db.transaction((): number => {
    const ids = (
      db.prepare(`SELECT id FROM ${TABLE} WHERE agent_key = ?`).all(agentKey) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    deleteIndexedFactRows(db, ids, vectorExtensionLoaded);
    return db.prepare(`DELETE FROM ${TABLE} WHERE agent_key = ?`).run(agentKey).changes;
  });
  return forget();
}

/**
 * Purge everything remembered by the agent with this id — the `agents:deleted`
 * door (TASK-718).
 *
 * An empty or non-string id THROWS, before a key is derived or a statement is
 * sent. `agentScopeKeyForAgentId('')` is a perfectly good digest (it is pinned),
 * so without this guard an event with a blank id would issue a real DELETE
 * against whatever partition an empty id maps to. The subscriber validates the
 * payload first and never reaches this with a bad id; this is the second lock
 * on the same door, for the next caller that is not the subscriber.
 */
export function purgeFactsForAgentId(
  db: BetterSqliteDb,
  agentId: string,
  vectorExtensionLoaded: boolean,
): number {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'agentId must be a non-empty string',
    });
  }
  return deleteFactsForKey(db, agentScopeKeyForAgentId(agentId), vectorExtensionLoaded);
}
