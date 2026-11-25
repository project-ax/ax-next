import type { DmAgentStore } from '../dm-agents.js';

/**
 * An in-memory DmAgentStore with the real one's rules (dm-agents.ts, held to
 * the same answers against Postgres in dm-agents.test.ts): one choice per
 * person, and a second `set` replaces the first; `get` answers the id as
 * stored, unchecked, or null; `removeForAgent` forgets every choice naming the
 * agent and answers how many went.
 *
 * `rows` is the store itself (userId to agentId): a test may plant a choice
 * there without a call being recorded, as the database would hold one.
 * `calls` records every method, with its arguments, in order, a faulted one
 * included. A `faults` entry that is set is thrown (as a rejection) by its
 * method, after the call is recorded and before anything changes; delete it
 * and the method answers again.
 */
export function memoryDmAgentStore(): {
  store: DmAgentStore;
  rows: Map<string, string>;
  calls: Array<{ method: 'get' | 'set' | 'removeForAgent'; args: string[] }>;
  faults: { get?: unknown; set?: unknown; removeForAgent?: unknown };
} {
  const rows = new Map<string, string>();
  const calls: Array<{ method: 'get' | 'set' | 'removeForAgent'; args: string[] }> = [];
  const faults: { get?: unknown; set?: unknown; removeForAgent?: unknown } = {};

  const store: DmAgentStore = {
    async get(userId) {
      calls.push({ method: 'get', args: [userId] });
      if (faults.get !== undefined) throw faults.get;
      return rows.get(userId) ?? null;
    },
    async set(userId, agentId) {
      calls.push({ method: 'set', args: [userId, agentId] });
      if (faults.set !== undefined) throw faults.set;
      rows.set(userId, agentId);
    },
    async removeForAgent(agentId) {
      calls.push({ method: 'removeForAgent', args: [agentId] });
      if (faults.removeForAgent !== undefined) throw faults.removeForAgent;
      let removed = 0;
      for (const [userId, chosen] of rows) {
        if (chosen !== agentId) continue;
        rows.delete(userId);
        removed += 1;
      }
      return removed;
    },
  };

  return { store, rows, calls, faults };
}
