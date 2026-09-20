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

// ---------------------------------------------------------------------------
// The two `query`-only probes (TASK-434), living beside `pendingStatus` for
// the same reason it exists: `recall` is the ONE place that assembles the
// `degraded` array, and the vocabulary is decided here rather than inline at
// three call sites (Invariant 4).
//
// Both are pure functions of an outcome the caller already has, not store
// reads — unlike `pendingStatus`, whose answer is only in the table. They are
// still functions and not inline ternaries because the flag names are the
// shared thing; a future third reason to raise `'semantic'` (a provider
// health signal, say) lands in one place.
//
// Both are raised ONLY on a `query` recall. An `about`-only listing runs no
// channels at all, so it has nothing to degrade — flagging it there would be
// noise, and a caller reading the flags as "memory is unhealthy" would read it
// wrong. `recall` enforces that by not calling these on the listing path.
// ---------------------------------------------------------------------------

/**
 * §4.4's `'semantic'`: the dense channel did not contribute to THIS answer.
 *
 * All three causes collapse to one flag on purpose — no embedder producer is
 * registered, the vector extension is unavailable on this host, or the embed
 * call failed or timed out. The caller cannot act differently on any of them:
 * the answer in hand was built lexically either way, and the distinction
 * belongs in an operator's logs, not in a payload field the model reads.
 */
export function semanticStatus(denseContributed: boolean): DegradedFlag[] {
  return denseContributed ? [] : ['semantic'];
}

/**
 * §4.4's `'ranking'`: the rerank step did not run, so the answer keeps raw
 * fusion order — the lexical fallback the design asks for. Same three causes,
 * same reason they collapse.
 *
 * The CALLER carves out one case this helper cannot see: an empty candidate
 * pool. `rerankDocuments` returns early on zero documents without ever
 * invoking the producer, so "did not run" is true but nothing was degraded —
 * `recall` passes `true` there rather than letting a day-one empty store
 * report ranking degradation on every query. Keep that decision at the call
 * site: this helper stays a pure `boolean -> flag` mapping.
 */
export function rankingStatus(reranked: boolean): DegradedFlag[] {
  return reranked ? [] : ['ranking'];
}
