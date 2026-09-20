import { sql, type Kysely } from 'kysely';
import type { DegradedFlag } from '@ax/memory-facts-contract';
import { TABLE, type MemoryFactsDatabase } from './schema.js';

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
 * ## ⚠ The cast is load-bearing, not cosmetic
 *
 * Postgres `count(*)` is `bigint`, and node-postgres hands a `bigint` back as
 * a **STRING** — it will not silently narrow a 64-bit integer into a JS
 * `number`. Uncast, this function would return `pending: "0"`, which is
 * `typeof 'string'`, TRUTHY, and therefore flips `degraded` to `['pending']`
 * for a perfectly clean tenant — permanently, since `"0" > 0` is also true.
 * `ReindexOutput.pending` is typed `number` and the contract compares it with
 * `toBe(0)`/`toEqual({... pending: 0 ...})`, so the lie surfaces there; it
 * would not surface from TypeScript, which believes the driver's declared
 * types. `::int` makes postgres return `int4`, which node-postgres DOES parse
 * to a JS number. `__tests__/postgres-edges.test.ts` asserts the runtime
 * `typeof`, not just the value.
 *
 * `int4` tops out at 2^31-1 rows in ONE tenant's pending backlog; a deployment
 * anywhere near that has a much louder problem than a narrowing cast.
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
export async function pendingStatus(
  db: Kysely<MemoryFactsDatabase>,
  agentKey: string,
): Promise<PendingStatus> {
  const row = await db
    .selectFrom(TABLE)
    .select(sql<number>`count(*)::int`.as('n'))
    .where('agent_key', '=', agentKey)
    .where('slot', '=', PENDING_SLOT)
    .executeTakeFirstOrThrow();
  const pending = row.n;
  return { pending, degraded: pending > 0 ? ['pending'] : [] };
}
