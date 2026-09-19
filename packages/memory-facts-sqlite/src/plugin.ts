import { randomUUID } from 'node:crypto';
import { PluginError, type Plugin } from '@ax/core';
import type {
  RecordInput,
  RecordOutput,
  RecordedStatement,
  FactStatementInput,
  RecallInput,
  RecallOutput,
  FactRecord,
  SupersedeInput,
  SupersedeOutput,
  ClearInput,
  Provenance,
} from '@ax/memory-facts-contract';
import { openDatabase, TABLE, INFINITY_SENTINEL, type FactRow } from './schema.js';
import { insertWithSlotClosure, supersedeIds } from './closure.js';
import { agentScopeKey } from './agent-scope-key.js';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

const PLUGIN_NAME = '@ax/memory-facts-sqlite';

// Hard upper bound on `limit`, mirroring `@ax/memory-strata-index-sqlite`'s
// MAX_TOP_K — a non-positive limit is a real risk to clamp/reject rather
// than let through to `LIMIT -1` (unbounded in SQLite).
const MAX_LIMIT = 200;

const PROVENANCES: readonly Provenance[] = ['extracted', 'agent', 'human'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// Every closure decision (rules 1-4, closure.ts) and recall's ORDER BY compare
// `when` lexicographically, which equals chronological order ONLY for a
// normalized ISO-8601 Z-suffixed instant — an unpadded date or epoch millis
// would silently mis-bound the (about, slot) chain with no error. `record`
// is the observer's door (default provenance `extracted` = model output),
// so this is a real trust-boundary check (Invariant 5), not decoration.
//
// The offset must be EXPLICIT (`Z` or `+HH:MM`/`-HH:MM`) rather than just
// "whatever Date.parse accepts": a bare local-time string like
// `2023-06-01T12:00:00` (no offset) parses as HOST-LOCAL time, so
// `.toISOString()` would silently shift the stored instant by the server's
// timezone — a correctness bug that varies by deployment, not just a loose
// message. Rejecting it here keeps the normalized value deployment-
// independent.
//
// The accepted grammar is narrower than "any ISO-8601 UTC instant" (the
// contract's doc comment on `FactStatementInput.when`): a colon-less offset
// (`+0530`), an hour-only offset (`+05`), and a no-seconds instant
// (`2023-06-01T12:00Z`) are all valid ISO-8601 but rejected here. Deliberate
// narrowing for a trust-boundary check, not an oversight — widen the regex
// if a real caller needs one of those forms.
//
// Residual, NOT closed by this check: `Date.parse` accepts (and this
// forwards) calendar-overflow instants like `2023-02-29T00:00:00Z` in a
// non-leap year or `...T24:00:00Z`, silently rolling them to the next valid
// date. That is deployment-independent (same result everywhere), unlike the
// TZ-shift bug this check exists for, so it's left as a known gap rather
// than adding full calendar validation here.
const EXPLICIT_OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function normalizeIsoInstant(field: string, value: string): string {
  const ms = Date.parse(value);
  if (!EXPLICIT_OFFSET_ISO.test(value) || !Number.isFinite(ms)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `statement.${field} must be an ISO-8601 instant with an explicit Z or +/-HH:MM offset`,
    });
  }
  return new Date(ms).toISOString();
}

function validateStatement(input: unknown): FactStatementInput {
  if (typeof input !== 'object' || input === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement must be an object',
    });
  }
  const s = input as Record<string, unknown>;
  for (const field of ['about', 'relation', 'value', 'when'] as const) {
    if (!isNonEmptyString(s[field])) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: `statement.${field} must be a non-empty string`,
      });
    }
  }
  const when = normalizeIsoInstant('when', s.when as string);
  if (s.slot !== undefined && !isNonEmptyString(s.slot)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement.slot must be a non-empty string when set',
    });
  }
  if (s.provenance !== undefined && !PROVENANCES.includes(s.provenance as Provenance)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: "statement.provenance must be 'extracted', 'agent', or 'human' when set",
    });
  }
  if (s.ownerUserId !== undefined && typeof s.ownerUserId !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement.ownerUserId must be a string when set',
    });
  }
  if (s.conversationId !== undefined && typeof s.conversationId !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statement.conversationId must be a string when set',
    });
  }
  return { ...s, when } as unknown as FactStatementInput;
}

interface ValidatedRecordInput {
  statements: FactStatementInput[];
  batchKey?: string;
}

function validateRecordInput(input: RecordInput): ValidatedRecordInput {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.statements)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'statements must be an array',
    });
  }
  // Same shape as every other optional string on the payload. An EMPTY
  // batchKey is rejected rather than treated as absent: `''` is falsy in JS
  // but a perfectly good TEXT value in SQLite, so letting it through would
  // silently pool every accidentally-empty-keyed batch in a tenant into one
  // dedup bucket and make the second such call a no-op.
  if (input.batchKey !== undefined && !isNonEmptyString(input.batchKey)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'batchKey must be a non-empty string when set',
    });
  }
  return {
    statements: input.statements.map(validateStatement),
    ...(input.batchKey !== undefined ? { batchKey: input.batchKey } : {}),
  };
}

function validateRecallInput(input: RecallInput): { about?: string; limit: number } {
  if (
    typeof input.limit !== 'number' ||
    !Number.isFinite(input.limit) ||
    input.limit < 1
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'limit must be a positive number',
    });
  }
  if (input.about !== undefined && typeof input.about !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'about must be a string when set',
    });
  }
  // `query` (free-text search) and `activeOnly: false` (history) are on the
  // contract's type for forward-compat (TASK-434, TASK-422) but this engine
  // doesn't implement either yet. Rejecting them loudly beats silently
  // returning fewer/more rows than a caller who read the type asked for.
  if (input.query !== undefined) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'query is not implemented yet (TASK-434) — omit it',
    });
  }
  if (input.activeOnly !== undefined && typeof input.activeOnly !== 'boolean') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'activeOnly must be a boolean when set',
    });
  }
  if (input.activeOnly === false) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'activeOnly: false (history) is not implemented yet (TASK-422) — omit it',
    });
  }
  return {
    ...(input.about !== undefined ? { about: input.about } : {}),
    limit: Math.min(Math.floor(input.limit), MAX_LIMIT),
  };
}

function rowToFactRecord(row: FactRow): FactRecord {
  return {
    id: row.id,
    about: row.about,
    relation: row.relation,
    value: row.value,
    when: row.valid_start,
    provenance: row.provenance,
    ...(row.valid_end !== INFINITY_SENTINEL ? { until: row.valid_end } : {}),
    ...(row.closed_by !== null ? { closedBy: row.closed_by } : {}),
  };
}

/**
 * Run a STORE-ACCESS region and make sure any failure inside it leaves the
 * caller holding an error, never a plausible-looking empty answer (design
 * §4.4: "an empty table is a valid answer; a failed store is not"). Without
 * this, a `SELECT` that throws mid-handler would propagate a raw
 * `SqliteError`/`TypeError` that nothing downstream recognises as "the memory
 * was unreachable" — and the temptation on the calling side is always to
 * catch-and-continue with zero facts, which silently rewrites the user's
 * memory to empty.
 *
 * Two deliberate choices:
 *
 *  - An already-thrown `PluginError` passes through UNTOUCHED. Payload
 *    validation runs BEFORE every wrapped region for the same reason, so an
 *    `invalid-payload` can never come back relabelled as a store outage and
 *    send the caller chasing the wrong problem. The `instanceof` re-throw is
 *    the belt to that braces.
 *  - Every non-`PluginError` failure gets ONE code, `store-unavailable`,
 *    even a constraint violation that is technically "the store is fine, your
 *    row isn't". The distinction has no caller today, and collapsing it keeps
 *    the promise simple: if `record`/`recall` returns, it touched the store.
 *    The original error is preserved on `cause` for whoever is debugging.
 */
function inStore<T>(hookName: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError({
      code: 'store-unavailable',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${hookName} could not reach the fact store`,
      cause: err,
    });
  }
}

/**
 * Rebuild a previously-stored batch's `RecordedStatement[]` from the rows
 * themselves — the idempotent-replay path (design §3.5). Nothing is written.
 *
 * Order is `batch_seq`, which is the ORIGINAL insertion order of the first
 * call and is deliberately NOT the retrying call's argument order: a retry
 * that happens to shuffle its statements must still describe the rows that
 * exist, in the order they were written. `transaction_time` cannot do this
 * job — `record` stamps one `now` across the whole batch — and `id` is a
 * random UUID, so `batch_seq` is the tiebreak that makes this deterministic.
 * See `FactRow.batch_seq`.
 *
 * One honest difference from the first call's response: these are the rows as
 * they stand NOW, not a recording of what was returned then. A row that a
 * LATER statement closed comes back carrying `until`/`closedBy`, and `closes`
 * is whatever currently points at it. That is the more truthful answer — and
 * it is the only one available, since the original response was never stored.
 */
function rebuildBatch(
  db: BetterSqliteDb,
  agentKey: string,
  batchKey: string,
): RecordedStatement[] {
  const rows = db
    .prepare(
      `SELECT * FROM ${TABLE}
        WHERE agent_key = ? AND batch_key = ?
        ORDER BY batch_seq`,
    )
    .all(agentKey, batchKey) as FactRow[];

  // `closes` is not a stored column — it is the inverse of `closed_by`,
  // re-derived per row and tenant-scoped like every other read here.
  const closesOf = db.prepare(
    `SELECT id FROM ${TABLE} WHERE agent_key = ? AND closed_by = ?`,
  );

  return rows.map((row) => ({
    ...rowToFactRecord(row),
    closes: (closesOf.all(agentKey, row.id) as Array<{ id: string }>).map((r) => r.id),
  }));
}

export interface MemoryFactsSqliteConfig {
  databasePath: string;
}

export function createMemoryFactsSqlitePlugin(config: MemoryFactsSqliteConfig): Plugin {
  let driver: BetterSqliteDb | undefined;

  /**
   * The one legal way to reach the driver from a handler.
   *
   * `driver` is `undefined` before `init` and after `shutdown`, and a
   * better-sqlite3 handle can also be closed underneath us (`.open === false`)
   * — the previous `driver!.prepare(...)` turned both into a bare
   * `TypeError: Cannot read properties of undefined`, which carries no code,
   * no plugin name, and nothing to tell a caller apart from a genuine bug in
   * the handler. This is the same outage, said out loud.
   */
  function requireDriver(): BetterSqliteDb {
    if (driver === undefined || !driver.open) {
      throw new PluginError({
        code: 'store-unavailable',
        plugin: PLUGIN_NAME,
        message: 'the fact store is not open (plugin not initialised, or already shut down)',
      });
    }
    return driver;
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'memory:facts:record',
        'memory:facts:recall',
        'memory:facts:supersede',
        'memory:facts:clear',
      ],
      calls: [],
      subscribes: [],
    },

    init({ bus }) {
      const opened = openDatabase(config.databasePath);
      driver = opened.driver;

      // Every handler derives the per-agent scope key from the calling ctx
      // so the single shared sqlite db is partitioned by agentId alone
      // (mirrors @ax/memory-strata-index-sqlite's TASK-257 partition). The
      // hook I/O payloads stay unchanged — the key is ambient (from ctx),
      // never a wire field.
      bus.registerService<RecordInput, RecordOutput>(
        'memory:facts:record',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Validation FIRST, outside the store region: a malformed payload is
          // the caller's bug and must keep saying `invalid-payload` even when
          // the store is also down. It is also what makes the batch
          // all-or-nothing cheap — every statement is known-good before a
          // single row is written, so the only way to fail partway is a store
          // failure, which the transaction below rolls back.
          const { statements, batchKey } = validateRecordInput(input);
          const agentKey = agentScopeKey(ctx);
          // ONE timestamp for the whole batch, which is why `batch_seq` has to
          // exist: `transaction_time` cannot order rows that all share it.
          const now = new Date().toISOString();

          const records = inStore('memory:facts:record', () => {
            const db = requireDriver();

            // The WHOLE batch settles in ONE transaction (design §3.5).
            // Previously each statement got its own, so a batch that died on
            // statement 3 left 1 and 2 committed — and a retry under the same
            // `batchKey` would then see "already recorded" and return a
            // permanently half-written batch. Atomicity is what makes the
            // idempotency key safe, not a separate nicety.
            //
            // `insertWithSlotClosure` opens its own transaction inside this
            // one; better-sqlite3 renders a nested transaction function as a
            // SAVEPOINT, so the outer BEGIN/COMMIT still bounds the batch.
            const settleBatch = db.transaction((): RecordedStatement[] => {
              // The dedup read lives INSIDE the transaction so the
              // check-then-write is not a race: two concurrent replays of the
              // same key cannot both decide the batch is new.
              //
              // "Rows exist for this key" IS the have-we-seen-it test. An
              // empty `statements` array therefore leaves no trace and stays
              // re-runnable forever — correct, because it stored nothing, so
              // there is nothing to be idempotent about.
              if (batchKey !== undefined) {
                const existing = rebuildBatch(db, agentKey, batchKey);
                if (existing.length > 0) return existing;
              }

              return statements.map((statement, index) => {
                const id = randomUUID();
                const closure = insertWithSlotClosure(db, agentKey, {
                  id,
                  about: statement.about,
                  relation: statement.relation,
                  value: statement.value,
                  when: statement.when,
                  provenance: statement.provenance ?? 'extracted',
                  transactionTime: now,
                  batchSeq: index,
                  ...(batchKey !== undefined ? { batchKey } : {}),
                  ...(statement.slot !== undefined ? { slot: statement.slot } : {}),
                  ...(statement.ownerUserId !== undefined
                    ? { ownerUserId: statement.ownerUserId }
                    : {}),
                  ...(statement.conversationId !== undefined
                    ? { conversationId: statement.conversationId }
                    : {}),
                });

                return {
                  id,
                  about: statement.about,
                  relation: statement.relation,
                  value: statement.value,
                  when: statement.when,
                  provenance: statement.provenance ?? 'extracted',
                  closes: closure.closed,
                  ...(closure.selfClosedAt !== null ? { until: closure.selfClosedAt } : {}),
                  ...(closure.selfClosedBy !== null ? { closedBy: closure.selfClosedBy } : {}),
                };
              });
            });

            return settleBatch();
          });

          return { records };
        },
      );

      bus.registerService<RecallInput, RecallOutput>(
        'memory:facts:recall',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Validation before the store region — see `record`.
          const { about, limit } = validateRecallInput(input);
          const agentKey = agentScopeKey(ctx);

          // The activeOnly-only cut (TASK-421 scope decision): always
          // filters to currently-active rows regardless of `input.
          // activeOnly`'s value, and never consults `input.query` — no
          // FTS/dense/RRF/rerank here (TASK-434).
          //
          // Recall is the handler where swallowing a store failure would be
          // most tempting and most harmful: "no facts" and "could not read the
          // facts" render identically to the model, and one of them is a lie.
          const rows = inStore('memory:facts:recall', () => {
            const db = requireDriver();
            return about !== undefined
              ? (db
                  .prepare(
                    `SELECT * FROM ${TABLE}
                    WHERE agent_key = ? AND about = ? AND valid_end = ?
                    ORDER BY valid_start DESC LIMIT ?`,
                  )
                  .all(agentKey, about, INFINITY_SENTINEL, limit) as FactRow[])
              : (db
                  .prepare(
                    `SELECT * FROM ${TABLE}
                    WHERE agent_key = ? AND valid_end = ?
                    ORDER BY valid_start DESC LIMIT ?`,
                  )
                  .all(agentKey, INFINITY_SENTINEL, limit) as FactRow[]);
          });

          return { statements: rows.map(rowToFactRecord), degraded: [] };
        },
      );

      bus.registerService<SupersedeInput, SupersedeOutput>(
        'memory:facts:supersede',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Validation before the store region — see `record`.
          if (!Array.isArray(input.ids)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'ids must be an array',
            });
          }
          const agentKey = agentScopeKey(ctx);
          const at = new Date().toISOString();
          // A supersede that silently did nothing is indistinguishable from
          // one whose ids were all foreign — `closed: []` is a legitimate
          // answer here, so a store failure MUST be an error instead.
          const closed = inStore('memory:facts:supersede', () =>
            supersedeIds(requireDriver(), agentKey, input.ids, at),
          );
          return { closed };
        },
      );

      bus.registerService<ClearInput, void>(
        'memory:facts:clear',
        PLUGIN_NAME,
        async (ctx, _input) => {
          const agentKey = agentScopeKey(ctx);
          // `clear` returns void, so a swallowed failure would report success
          // for a tenant whose data is still there — the worst possible lie
          // for a "forget this" operation.
          inStore('memory:facts:clear', () => {
            requireDriver().prepare(`DELETE FROM ${TABLE} WHERE agent_key = ?`).run(agentKey);
          });
        },
      );
    },

    shutdown() {
      if (driver !== undefined && driver.open) {
        driver.close();
      }
      driver = undefined;
    },
  };
}
