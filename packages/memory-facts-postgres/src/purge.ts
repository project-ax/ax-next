import { PluginError } from '@ax/core';
import { TABLE } from './schema.js';
import { agentScopeKeyForAgentId } from './agent-scope-key.js';
import type { FactsDatabase } from './closure.js';

const PLUGIN_NAME = '@ax/memory-facts-postgres';

/**
 * Delete EVERY row this engine holds for one scope key, closed history
 * included, and say how many went.
 *
 * The one place "forget this partition" is spelled, shared by
 * `memory:facts:clear` (the calling agent forgets) and the `agents:deleted`
 * purge (the agent no longer exists), so the two cannot drift into forgetting
 * different things (Invariant 4).
 *
 * `memory_facts_v1` is the only table in this package that carries
 * `agent_key`. Postgres has no derived-index shadow tables to sweep (the sqlite
 * twin has FTS5/vec0 ones), so this is one statement — and one statement is
 * one transaction: it deletes all of the partition or none of it.
 *
 * `numDeletedRows` is a **bigint** in Kysely's postgres dialect (the same trap
 * as `numUpdatedRows`, see `reindex`), hence the `Number(...)`. A partition is
 * nowhere near 2^53 rows.
 */
export async function deleteFactsForKey(store: FactsDatabase, agentKey: string): Promise<number> {
  const out = await store.deleteFrom(TABLE).where('agent_key', '=', agentKey).executeTakeFirst();
  return Number(out.numDeletedRows);
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
export async function purgeFactsForAgentId(store: FactsDatabase, agentId: string): Promise<number> {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'agentId must be a non-empty string',
    });
  }
  return deleteFactsForKey(store, agentScopeKeyForAgentId(agentId));
}
