import type { Database as BetterSqliteDb } from 'better-sqlite3';
import type { DegradedFlag } from '@ax/memory-facts-contract';
import { TABLE } from './schema.js';

/**
 * The reserved `slot` value meaning "the caller's normalizer could not derive
 * a slot yet" (design §3.5). A row carrying it is stored and retrievable but
 * INERT for closure — it closes nothing and nothing closes it, exactly like a
 * no-slot row — until `memory:facts:reindex` is handed the resolved slot.
 *
 * DUPLICATED from `@ax/memory-facts-contract`'s `PENDING_SLOT`, deliberately.
 * That package is the spelling of record for both backends (Invariant 4), but
 * it ships the shared vitest suite and therefore depends on `vitest` at
 * RUNTIME — it is a devDependency here. A `import type` from it is erased and
 * costs nothing; importing the CONSTANT would drag a test runner into this
 * plugin's production graph. `__tests__/pending-slot.test.ts` asserts the two
 * constants are equal, so a drift between them is a failing test rather than a
 * silent split-brain where one backend writes `pending` and the other reads
 * something else.
 */
export const PENDING_SLOT = 'pending';

export interface PendingStatus {
  /** Rows in this tenant whose slot has still not been derived. */
  pending: number;
  /** The `recall`/`reindex` degraded vocabulary, derived from `pending`. */
  degraded: DegradedFlag[];
}

/**
 * The one place `pending` is counted and turned into a `degraded` flag, so
 * `memory:facts:recall` and `memory:facts:reindex` cannot drift into
 * disagreeing about whether this tenant is degraded (Invariant 4).
 *
 * Why undrained pending rows are a DEGRADED answer and not just a backlog:
 * supersession has not fully run for this tenant, so a value that a later
 * statement should already have closed can still read as active. That is
 * under-closing — the safe direction (§3.5) — but it is still an answer built
 * on less than the full machinery, which is exactly what §4.4's flag is for.
 *
 * A pending row that has since been RETRACTED (`memory:facts:supersede`) is
 * still counted. It asserts nothing, so it cannot actually skew a recall, and
 * counting it therefore over-reports slightly. Deliberate: the drain's job
 * list is "rows whose slot was never derived", `reindex` can still resolve
 * one, and over-flagging degraded is the same safe direction as pending
 * itself. Under-flagging would be the bug.
 */
export function pendingStatus(driver: BetterSqliteDb, agentKey: string): PendingStatus {
  const row = driver
    .prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE agent_key = ? AND slot = ?`)
    .get(agentKey, PENDING_SLOT) as { n: number };
  const pending = row.n;
  return { pending, degraded: pending > 0 ? ['pending'] : [] };
}
