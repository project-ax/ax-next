import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { FactKind } from '@ax/memory-facts-contract';

export const TABLE = 'memory_facts_v1';

/** FTS5 shadow table over `about`/`relation`/`value` — see the block below `migrateAddColumns`. */
export const FTS_TABLE = 'memory_facts_v1_fts';

/** `vec0` shadow table over the dense embedding — see the block below `migrateAddColumns`. */
export const VEC_TABLE = 'memory_facts_v1_vec';

/**
 * Dimensionality of the stored embedding (bge-small, matching `dem-memory` and
 * `memory-strata-index-sqlite`'s own `vec0` table). `vectorToBlob` enforces
 * this at the boundary so a mismatched embedder fails loudly at the write
 * site rather than corrupting `vec0`'s fixed-width column silently.
 */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Ported verbatim from `dem-memory/src/db/memory-repository.ts`. `vec0`
 * stores embeddings as raw `Float32Array` bytes, not JSON — `sqlite-vec`
 * reads the blob directly as a packed float vector, so the byte length IS the
 * dimension count as far as the extension is concerned. The explicit length
 * check exists because a silently-truncated or padded blob would still
 * "work" (no error from `sqlite-vec`) while comparing distances over the
 * wrong dimensionality.
 */
export function vectorToBlob(vector: readonly number[]): Buffer {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}`,
    );
  }
  return Buffer.from(new Float32Array(vector).buffer);
}

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
  kind: FactKind | null;
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
   * the millisecond. Nor can `id` — it is a random UUID. Nor is `rowid` safe:
   * SQLite explicitly reserves the right to renumber it during `VACUUM` on a
   * table (like this one) whose primary key is not an INTEGER. A stored
   * counter is the only tiebreak that survives all three.
   *
   * Set on every row, batched or not, so the column has one meaning.
   */
  batch_seq: number | null;
}

// ---------------------------------------------------------------------------
// Close-on-exit safety net — copied verbatim (pattern and rationale) from
// `@ax/memory-strata-index-sqlite`'s `schema.ts`.
//
// better-sqlite3's `Database` destructor calls `RemoveEnvironmentCleanupHook`.
// If a Database is still OPEN when the Node environment tears down, that hook
// removal runs with a null env and aborts the process (SIGABRT, no exception).
// Under vitest's forks pool that surfaces as `Worker exited unexpectedly`,
// blaming whichever test file the dying worker happened to hold.
//
// `shutdown()` (closing the driver) remains the real contract; this is the
// net under every caller that exits without one.
//
// STRONG references, deliberately: keeping a handle reachable stops GC from
// finalizing it on V8's own schedule, which is what triggers the abort if it
// lands mid-teardown. The only thing that closes a tracked driver is this
// sweep, on `exit`, while the environment is still alive.
// ---------------------------------------------------------------------------

const openDrivers = new Set<BetterSqliteDb>();
let exitHookInstalled = false;

/** Exported for a regression test, mirroring the sibling package's pattern. */
export function closeTrackedDatabasesForExit(): void {
  for (const driver of openDrivers) {
    try {
      if (driver.open) driver.close();
    } catch {
      // The process is on its way out; nothing left to corrupt or report.
    }
  }
  openDrivers.clear();
}

function trackDriver(driver: BetterSqliteDb): void {
  openDrivers.add(driver);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', closeTrackedDatabasesForExit);
}

export interface OpenDatabaseResult {
  driver: BetterSqliteDb;
  /**
   * Whether the `sqlite-vec` extension loaded successfully on THIS platform,
   * for THIS open. `false` means the dense channel has no `VEC_TABLE` to read
   * or write — a later task (T3/T4) raises the `'semantic'` degraded flag
   * from this, rather than `recall` re-deriving it by, say, probing for the
   * table's existence on every call.
   *
   * The load can fail for reasons entirely outside our control: no prebuilt
   * binary for this OS/arch (`sqlite-vec`'s optional platform packages cover
   * five targets, not every target), a sandboxed runtime that disallows
   * `loadExtension` outright, or a corrupted/partial install. None of those
   * are bugs in this plugin, so none of them may throw out of `openDatabase` —
   * see the guarded `try`/`catch` below.
   */
  vectorExtensionLoaded: boolean;
}

export function openDatabase(databasePath: string): OpenDatabaseResult {
  // `allowExtension` is required for `sqliteVec.load` below to be permitted
  // at all — better-sqlite3 rejects `loadExtension` calls without it. Not yet
  // reflected in `@types/better-sqlite3` (7.6.13), hence the cast.
  const driver = new BetterSqlite3(databasePath, {
    allowExtension: true,
  } as ConstructorParameters<typeof BetterSqlite3>[1]);
  trackDriver(driver);
  driver.pragma('journal_mode = WAL');

  // Guarded, deliberately: a load failure here must degrade the dense
  // channel to unavailable, never fail the whole store. See
  // `OpenDatabaseResult.vectorExtensionLoaded`'s docblock for why this can
  // fail on a platform we don't control.
  let vectorExtensionLoaded = true;
  try {
    sqliteVec.load(driver);
  } catch {
    vectorExtensionLoaded = false;
  }

  // Fully static SQL — no user input, no injection risk.
  driver.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL,
      about TEXT NOT NULL,
      relation TEXT NOT NULL,
      value TEXT NOT NULL,
      slot TEXT,
      provenance TEXT NOT NULL CHECK(provenance IN ('extracted','agent','human')),
      owner_user_id TEXT,
      conversation_id TEXT,
      kind TEXT,
      valid_start TEXT NOT NULL,
      valid_end TEXT NOT NULL DEFAULT '${INFINITY_SENTINEL}',
      transaction_time TEXT NOT NULL,
      closed_by TEXT,
      batch_key TEXT,
      batch_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_facts_slot ON ${TABLE}(agent_key, about, slot, valid_end);
  `);

  // `CREATE TABLE IF NOT EXISTS` is a no-op against a db TASK-421 already
  // created, so that db would keep the 13-column shape forever and every
  // `batch_key` read would fail with "no such column". The additive migration
  // below is what actually moves an existing store forward. It has to run
  // BEFORE idx_facts_batch, which indexes the column it adds. It also creates
  // the FTS5/vec0 shadow tables (TASK-434) — see its docblock for why that
  // lives here rather than in a second migration helper.
  migrateAddColumns(driver, vectorExtensionLoaded);

  driver.exec(
    `CREATE INDEX IF NOT EXISTS idx_facts_batch ON ${TABLE}(agent_key, batch_key);`,
  );

  // `(agent_key, slot)` — the pending probe. `memory:facts:recall` asks "does
  // this tenant hold any `slot = 'pending'` row?" on EVERY read to build its
  // `degraded` flag, and idx_facts_slot cannot serve that: `about` sits
  // between `agent_key` and `slot` in its key, so the question would degrade
  // to a full scan of the tenant on the hot read path.
  driver.exec(`CREATE INDEX IF NOT EXISTS idx_facts_pending ON ${TABLE}(agent_key, slot);`);

  // `(agent_key, valid_end, transaction_time DESC, valid_start DESC)` — the
  // temporal channel (TASK-434). That channel ADMITS candidates rather than
  // ranking ones another channel found, so it runs on every `query` recall and
  // always sorts the tenant's rows by a key no other index carries: none of the
  // three above mentions `transaction_time`, so without this the hot read path
  // is a scan of the tenant plus a sort. The DESC markers match the query's own
  // direction, which is what lets SQLite walk the index instead of sorting.
  // `valid_end` sits second because the channel's common case is the
  // `activeOnly` equality on the sentinel. `id DESC` is in the key rather than
  // left to a sort: measured with EXPLAIN QUERY PLAN, omitting it still SEARCHes
  // this index but adds `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, because a
  // TEXT primary key is not the rowid the index carries implicitly.
  driver.exec(
    `CREATE INDEX IF NOT EXISTS idx_facts_temporal
       ON ${TABLE}(agent_key, valid_end, transaction_time DESC, valid_start DESC, id DESC);`,
  );

  return { driver, vectorExtensionLoaded };
}

/**
 * Add any column this version needs that an older db does not have, and
 * create the derived-index shadow tables (FTS5, `vec0`) a pre-TASK-434 db
 * won't have either.
 *
 * Idempotent by construction: `PRAGMA table_info` is read first and a column
 * already present is skipped, so a second `openDatabase` on the same file is a
 * no-op rather than a "duplicate column name" throw. (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, which is why the pragma is needed at all.)
 *
 * Every identifier here is a module constant — `TABLE` and the literal column
 * names — so the SQL stays fully static even though it is template-built. No
 * caller value reaches it.
 *
 * The FTS5/vec0 tables are deliberately migrated in THIS function rather than
 * a second helper: they are, structurally, the same problem — "a db opened by
 * an older version of this file is missing something the current version
 * needs" — and `CREATE VIRTUAL TABLE IF NOT EXISTS` is its own idempotence
 * guard, so no `PRAGMA table_info`-style presence check is needed for them.
 * (Virtual tables have no `ALTER TABLE ADD COLUMN` story at all — if a future
 * change needs new columns on either shadow table, that IS a second
 * migration, e.g. `memory-strata-index-sqlite`'s versioned-table approach,
 * not an extension of this one.)
 */
function migrateAddColumns(driver: BetterSqliteDb, vectorExtensionLoaded: boolean): void {
  const present = new Set(
    (driver.pragma(`table_info(${TABLE})`) as Array<{ name: string }>).map((c) => c.name),
  );
  // Nullable and with no default, so the ALTER is instant and needs no
  // backfill: an older row genuinely has no batch, and NULL says exactly that.
  // A NULL `batch_key` never matches a dedup lookup, because every lookup
  // binds a non-empty string.
  if (!present.has('batch_key')) {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN batch_key TEXT`);
  }
  if (!present.has('batch_seq')) {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN batch_seq INTEGER`);
  }
  if (!present.has('kind')) {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN kind TEXT`);
  }

  // Sparse channel (TASK-434). `porter unicode61` matches both `dem-memory`
  // and `@ax/memory-strata-index-sqlite` — same stemming/tokenizing behaviour
  // for the same class of query. `id UNINDEXED`: it is an exact-match join key
  // back to `TABLE`, never itself full-text-searched. Built into
  // better-sqlite3 (FTS5 ships compiled in), so unlike `vec0` this needs no
  // extension load and no availability guard.
  driver.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      id UNINDEXED,
      about,
      relation,
      value,
      tokenize = 'porter unicode61'
    );
  `);

  // Dense channel (TASK-434). Only created when the extension actually
  // loaded — `vec0` is a virtual-table module `sqlite-vec` registers, so
  // issuing this DDL without it would throw "no such module: vec0" and take
  // `openDatabase` down with it, defeating the whole point of the guard
  // above. A db opened once WITHOUT the extension and later WITH it will
  // simply pick up `VEC_TABLE` on that later open — still additive, just
  // gated on a runtime capability instead of a schema version.
  if (vectorExtensionLoaded) {
    driver.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSIONS}]
      );
    `);
  }
}

export interface FtsIndexInput {
  id: string;
  about: string;
  relation: string;
  value: string;
}

export interface IndexFactRowOptions {
  /**
   * The fact's dense embedding, when one could be produced. Absent means "no
   * embedder was available for this write" — an ordinary state, not an error;
   * `memory:facts:reindex` backfills the vector later.
   */
  vector?: readonly number[];
  /**
   * Whether THIS connection can use {@link VEC_TABLE} — `openDatabase`'s
   * {@link OpenDatabaseResult.vectorExtensionLoaded}, threaded through by the
   * caller rather than re-derived here.
   *
   * It has to be the CONNECTION's answer and not "does the table exist": a db
   * created on a machine with the prebuilt binary and reopened on one without
   * it still has a `VEC_TABLE` row in `sqlite_master`, and every statement
   * touching it throws `no such module: vec0`. Asking `sqlite_master` would
   * say yes and then fail.
   */
  vectorExtensionLoaded: boolean;
}

export interface IndexFactRowResult {
  /**
   * Whether the dense vector actually landed in {@link VEC_TABLE}. `false`
   * when no vector was supplied or the extension is unavailable — the caller
   * turns that into §4.4's `'semantic'` signal instead of guessing.
   */
  vectorStored: boolean;
}

/**
 * Populate (or refresh) the derived-index rows for one fact — the FTS5 row
 * always, the `vec0` row when a vector is supplied and the extension is
 * available. `record` calls this inside its existing write transaction;
 * `reindex` calls it in a backfill loop.
 *
 * IDEMPOTENT PER ID, by delete-then-insert. FTS5 has no primary key and no
 * upsert, so an unconditional INSERT would give a re-indexed fact two rows —
 * and `reindex`'s backfill re-indexes by design. The sparse channel would then
 * return that id twice and `reciprocalRankFusion` would sum `1/(k+rank+1)`
 * twice for one row, quietly promoting whichever facts happened to be indexed
 * more often. ("Append-only" in the T2 design note was about not tracking
 * `valid_end` in the shadow table — see the paragraph below — never a licence
 * for duplicate ids.)
 *
 * What IS append-only is validity: nothing here, and no trigger anywhere in
 * this module, ever removes an FTS row because a fact was superseded or
 * closed. Staleness is filtered by joining `FTS_TABLE` back to `TABLE` on `id`
 * at query time, so `TABLE.valid_end`/`closed_by` stay the SOLE authority on
 * what is current (Invariant 4) — a trigger-synced mirror would be a second
 * copy of that authority, and the two are exactly the kind of thing that
 * drifts. (`clear` is the one exception, and it deletes the base row too: a
 * "forget this" that left the text searchable in a shadow table would be a
 * retention bug, not a validity question.)
 *
 * No bare `catch` around the vector write, deliberately. The three things the
 * old one collapsed into "shrug" are now three different outcomes:
 *
 *  - `vectorToBlob` rejecting a mis-shaped vector is a PROGRAMMING error (the
 *    embedder returned the wrong dimensionality) and throws, which is why it
 *    is computed before anything is written.
 *  - the extension being unavailable is a platform capability gap, decided by
 *    ASKING (`options.vectorExtensionLoaded`) rather than by failing, and
 *    reported as `vectorStored: false`.
 *  - anything else — a real failure against a `vec0` table that exists — is a
 *    store failure and propagates, so `record`'s `inStore` reports it as
 *    `store-unavailable` rather than committing a fact whose vector silently
 *    went missing.
 *
 * A failed FTS insert is likewise not caught: FTS5 ships compiled into
 * better-sqlite3, so a throw there means something is genuinely broken.
 */
export function indexFactRow(
  driver: BetterSqliteDb,
  fact: FtsIndexInput,
  options: IndexFactRowOptions,
): IndexFactRowResult {
  // Computed BEFORE the first write so a dimension mismatch cannot leave the
  // FTS row written and the vector absent.
  const blob = options.vector === undefined ? undefined : vectorToBlob(options.vector);

  driver.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`).run(fact.id);
  driver
    .prepare(`INSERT INTO ${FTS_TABLE} (id, about, relation, value) VALUES (?, ?, ?, ?)`)
    .run(fact.id, fact.about, fact.relation, fact.value);

  if (blob === undefined || !options.vectorExtensionLoaded) return { vectorStored: false };

  driver
    .prepare(`INSERT OR REPLACE INTO ${VEC_TABLE} (id, embedding) VALUES (?, ?)`)
    .run(fact.id, blob);
  return { vectorStored: true };
}

/**
 * Drop the derived-index rows for a set of ids — the counterpart to
 * `indexFactRow`, used by `memory:facts:clear` only.
 *
 * It exists because `clear` DELETEs the base rows: without this the FTS5
 * shadow would keep the tenant's statement text on disk forever, unreachable
 * through recall (the join drops it) but very much still there. For a
 * "forget this" operation that is the wrong kind of leftover.
 *
 * `vectorExtensionLoaded` gates the `vec0` delete for the same reason
 * `indexFactRow`'s write is gated: the table can exist in `sqlite_master`
 * while the module is unavailable on this connection.
 */
export function deleteIndexedFactRows(
  driver: BetterSqliteDb,
  ids: readonly string[],
  vectorExtensionLoaded: boolean,
): void {
  if (ids.length === 0) return;
  const dropFts = driver.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`);
  const dropVec = vectorExtensionLoaded
    ? driver.prepare(`DELETE FROM ${VEC_TABLE} WHERE id = ?`)
    : undefined;
  for (const id of ids) {
    dropFts.run(id);
    dropVec?.run(id);
  }
}
