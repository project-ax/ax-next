import { sql, type Kysely } from 'kysely';

export const TABLE = 'memory_facts_v1';

/** Sentinel `valid_end` value meaning "still active" — never actually the year 9999. */
export const INFINITY_SENTINEL = '9999-12-31T23:59:59.999Z';

export interface FactRow {
  id: string;
  agent_key: string;
  about: string;
  relation: string;
  value: string;
  slot: string | null;
  provenance: 'extracted' | 'agent' | 'human';
  owner_user_id: string | null;
  conversation_id: string | null;
  /**
   * ⚠ `TEXT`, not `timestamptz` — and so is {@link FactRow.valid_end}. See the
   * REVISIT trigger on {@link runFactsMigration}.
   */
  valid_start: string;
  valid_end: string;
  transaction_time: string;
  closed_by: string | null;
  /**
   * The `batchKey` of the `memory:facts:record` call that wrote this row, or
   * NULL when the caller passed none. Every row of one batch carries the same
   * value; dedup is `(agent_key, batch_key)`, never `batch_key` alone.
   */
  batch_key: string | null;
  /**
   * 0-based position of this row WITHIN its batch.
   *
   * It exists because `transaction_time` cannot order a batch: `record`
   * computes `now` once per call, so every row of a batch shares one value to
   * the millisecond. Nor can `id` — it is a random UUID. Nor is any physical
   * row address safe to lean on (`ctid` moves on every UPDATE, and this table
   * UPDATEs `valid_end` constantly). A stored counter is the only tiebreak
   * that survives all three.
   *
   * Set on every row, batched or not, so the column has one meaning.
   *
   * `integer` on the wire, and node-postgres parses `int4` to a JS `number` —
   * unlike `bigint`/`count(*)`, which it hands back as a STRING. Keep it
   * `INTEGER`.
   */
  batch_seq: number | null;
}

/** The typed schema witness for this plugin's slice of the shared database. */
export interface MemoryFactsDatabase {
  /** Spelled out rather than `[TABLE]` — a computed key would erase the literal. */
  memory_facts_v1: FactRow;
}

/**
 * Idempotent DDL, run at `init()` — the repo-wide convention (no migrations
 * table; the table NAME carries the version, as in
 * `@ax/memory-strata-index-postgres`'s `runIndexMigration`).
 *
 * Schema-agnostic on purpose (mirrors `runIndexMigration`): callers pass
 * `Kysely<anything>` and we issue raw DDL via `sql``.execute()`. Every
 * identifier and literal below is a module constant — no caller value reaches
 * it, so the SQL is fully static even though it is template-built.
 *
 * ## ⚠ REVISIT TRIGGER — why `valid_start`/`valid_end` are `TEXT`
 *
 * Both are `TEXT`, including the `'9999-12-31T23:59:59.999Z'` sentinel,
 * exactly as the sqlite twin stores them. The instinct is that postgres `TEXT`
 * ordering is collation-dependent and therefore dangerous. It is not
 * load-bearing here, but be precise about WHY, because the obvious reason is
 * wrong:
 *
 *  - Every comparison the CLOSURE RULES make runs in JavaScript, inside
 *    `settleArrival` (`peer.valid_start <= arrival.when`, `peer.valid_end >
 *    arrival.when`, and a `localeCompare` tiebreak). Those are collation-immune
 *    because they never reach the database at all.
 *  - But the SQL does NOT only compare these columns by equality. `recall`
 *    issues `.orderBy('valid_start', 'desc')` — a genuine SQL ordering over a
 *    `TEXT` column, evaluated under the database's collation.
 *
 * What actually makes that safe is the SHAPE of the values, not where they are
 * compared: every instant stored here is canonical fixed-width
 * `YYYY-MM-DDTHH:MM:SS.sssZ` (enforced at the write door by
 * `normalizeIsoInstant`), and `INFINITY_SENTINEL` has the identical shape.
 * Same length, same punctuation in the same positions, digits only elsewhere —
 * so lexicographic order agrees with chronological order under ANY collation.
 *
 * REVISIT THIS if either of those stops holding: a non-canonical value reaching
 * these columns (a migration, a backfill, a second write path that skips
 * `normalizeIsoInstant`), or a RANGE comparison (`<`/`>`) on them moving into
 * SQL, where the database's answer and `settleArrival`'s JS answer would have
 * to agree. TASK-457's temporal channel is the likely trigger for the second.
 *
 * `timestamptz` would also cost more than it buys: `rowToFactRecord` decides
 * whether to emit `until` by comparing `valid_end !== INFINITY_SENTINEL` as a
 * STRING, and `normalizeIsoInstant` hands the caller back its canonical string
 * verbatim as `when` — a `timestamptz` round-trip returns a JS `Date` and
 * would have to reproduce both byte-for-byte, trailing `.000Z` included.
 *
 * **Revisit if and only if** a future card pushes an ordering or RANGE
 * comparison down into SQL — TASK-457's temporal channel plausibly will. At
 * that point `timestamptz`, or a `C`-collated column, becomes the right call,
 * and this comment is the note that says so out loud rather than leaving the
 * next person to rediscover it.
 */
export async function runFactsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS memory_facts_v1 (
      id               TEXT PRIMARY KEY,
      agent_key        TEXT NOT NULL,
      about            TEXT NOT NULL,
      relation         TEXT NOT NULL,
      value            TEXT NOT NULL,
      slot             TEXT,
      provenance       TEXT NOT NULL CHECK (provenance IN ('extracted','agent','human')),
      owner_user_id    TEXT,
      conversation_id  TEXT,
      valid_start      TEXT NOT NULL,
      valid_end        TEXT NOT NULL DEFAULT ${sql.lit(INFINITY_SENTINEL)},
      transaction_time TEXT NOT NULL,
      closed_by        TEXT,
      batch_key        TEXT,
      batch_seq        INTEGER
    )
  `.execute(db);

  // Additive migration for a database whose table predates these two columns.
  // Postgres HAS `ADD COLUMN IF NOT EXISTS`, so there is no `PRAGMA
  // table_info` dance to port from the sqlite twin. Nullable and with no
  // default, so each ALTER is instant and needs no backfill: an older row
  // genuinely has no batch, and NULL says exactly that. A NULL `batch_key`
  // never matches a dedup lookup, because every lookup binds a non-empty
  // string. Runs BEFORE the batch index, which indexes the column it adds.
  await sql`ALTER TABLE memory_facts_v1 ADD COLUMN IF NOT EXISTS batch_key TEXT`.execute(db);
  await sql`ALTER TABLE memory_facts_v1 ADD COLUMN IF NOT EXISTS batch_seq INTEGER`.execute(db);

  // The slot chain — `insertWithSlotClosure`'s peer query and
  // `resettleSlotGroups`' group read.
  await sql`
    CREATE INDEX IF NOT EXISTS memory_facts_v1_slot_idx
      ON memory_facts_v1 (agent_key, about, slot, valid_end)
  `.execute(db);

  // The batch dedup/replay read.
  await sql`
    CREATE INDEX IF NOT EXISTS memory_facts_v1_batch_idx
      ON memory_facts_v1 (agent_key, batch_key)
  `.execute(db);

  // `(agent_key, slot)` — the pending probe. `memory:facts:recall` asks "does
  // this tenant hold any `slot = 'pending'` row?" on EVERY read to build its
  // `degraded` flag, and the slot index cannot serve that: `about` sits
  // between `agent_key` and `slot` in its key, so the question would degrade
  // to a full scan of the tenant on the hot read path.
  await sql`
    CREATE INDEX IF NOT EXISTS memory_facts_v1_pending_idx
      ON memory_facts_v1 (agent_key, slot)
  `.execute(db);
}
