import { randomUUID } from 'node:crypto';
import { makeAgentContext, PluginError, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
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
  ReindexInput,
  ReindexOutput,
  ResolvedSlot,
} from '@ax/memory-facts-contract';
import {
  runFactsMigration,
  TABLE,
  INFINITY_SENTINEL,
  type FactRow,
  type MemoryFactsDatabase,
} from './schema.js';
import {
  insertWithSlotClosure,
  resettleSlotGroups,
  supersedeIds,
  type FactsDatabase,
  type FactsTransaction,
  type SlotGroup,
} from './closure.js';
import { PENDING_SLOT, pendingStatus } from './pending.js';
import { agentScopeKey } from './agent-scope-key.js';

const PLUGIN_NAME = '@ax/memory-facts-postgres';

// Hard upper bound on `limit`, mirroring @ax/memory-facts-sqlite's MAX_LIMIT
// (and @ax/memory-strata-index-*'s MAX_TOP_K) — a non-positive limit is a
// real risk to clamp/reject rather than let through to the driver.
//
// Duplicated rather than imported: Invariant 2 forbids cross-plugin imports
// even for a pure constant. Drift between the two backends is caught by the
// shared contract's clamp case.
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
// It is also what lets `valid_start`/`valid_end` stay `TEXT` on postgres
// without inheriting a collation question: every stored instant is canonical
// fixed-width, so lexicographic and chronological order agree under any
// collation (see `schema.ts`'s REVISIT trigger).
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
  // but a perfectly good TEXT value in postgres, so letting it through would
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

function validateRecallInput(input: RecallInput): {
  about?: string;
  ownerUserId?: string;
  limit: number;
  activeOnly: boolean;
} {
  if (typeof input.limit !== 'number' || !Number.isFinite(input.limit) || input.limit < 1) {
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
  // `query` (free-text search) is implemented on the SQLITE twin as of
  // TASK-434 and is not implemented here: there is no tsvector, no GIN index
  // and no pgvector, deliberately — TASK-457 owns those channels and owns
  // deciding what they should be, and TASK-458 owns the prior question of
  // whether pgvector is even available in the image we deploy.
  //
  // So the two backends now deliberately DIFFER on this input, which is a
  // thing the shared contract has to be TOLD rather than left to discover:
  // `runFactsContract`'s factory takes a capability descriptor, this backend
  // declares no `fusionRecall`, and the contract therefore runs the rejection
  // case here and the fusion cases against sqlite. When TASK-457 lands it
  // flips that one boolean and inherits the fusion cases.
  //
  // Rejecting loudly still beats silently returning an unfiltered result set
  // to a caller who read the type and expected it to narrow the answer.
  if (input.query !== undefined) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'query is not implemented on the postgres engine yet (TASK-457) — omit it',
    });
  }
  // Owner scope (design §6.1). Same non-empty-string rule as `batchKey`, and
  // it earns it harder: `''` is falsy in JS but a perfectly good TEXT value in
  // postgres, so treating it as absent would hand a caller who ASKED to be
  // scoped the whole tenant instead — a read silently WIDER than the one it
  // requested, which is the one direction a scope must never fail in.
  // Rejecting is the only outcome the caller can detect.
  if (input.ownerUserId !== undefined && !isNonEmptyString(input.ownerUserId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'ownerUserId must be a non-empty string when set',
    });
  }
  if (input.activeOnly !== undefined && typeof input.activeOnly !== 'boolean') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'activeOnly must be a boolean when set',
    });
  }
  return {
    ...(input.about !== undefined ? { about: input.about } : {}),
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
    limit: Math.min(Math.floor(input.limit), MAX_LIMIT),
    // Omitted or `true` -> only currently-active rows (unchanged TASK-421
    // behavior). `false` -> history mode (design §4.2): no validity filter,
    // so closed rows come back too, each carrying `until` and (for a
    // rule-closure) `closedBy` via `rowToFactRecord` — no new field needed.
    activeOnly: input.activeOnly !== false,
  };
}

/**
 * `memory:facts:reindex`'s payload check. Runs BEFORE the store region for
 * the same reason every other hook's does — a malformed payload is the
 * caller's bug and must keep saying `invalid-payload` even when the store is
 * also down — and it is also what makes the drain all-or-nothing: every entry
 * is known-good before a single slot is written, so the only way to fail
 * partway is a store failure, which the transaction rolls back.
 *
 * `slot: null` is legal and means "no slot after all" — a real outcome of the
 * caller's normalizer, and the row stays inert forever.
 *
 * `slot: PENDING_SLOT` is REJECTED rather than treated as a no-op. Resolving
 * a pending row to "pending" cannot be anything but a caller bug (most likely
 * echoing the row back unchanged), and silently accepting it would report
 * `resolved: 1` for a row that is still undrained — a lie in the one number
 * this hook exists to make trustworthy.
 */
function validateReindexInput(input: ReindexInput): ResolvedSlot[] {
  if (typeof input !== 'object' || input === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'reindex input must be an object',
    });
  }
  if (input.slots === undefined) return [];
  if (!Array.isArray(input.slots)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'slots must be an array when set',
    });
  }
  return input.slots.map((entry): ResolvedSlot => {
    if (typeof entry !== 'object' || entry === null) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'each slots entry must be an object',
      });
    }
    const e = entry as unknown as Record<string, unknown>;
    if (!isNonEmptyString(e.id)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'slots[].id must be a non-empty string',
      });
    }
    if (e.slot !== null && !isNonEmptyString(e.slot)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'slots[].slot must be a non-empty string, or null for "no slot after all"',
      });
    }
    if (e.slot === PENDING_SLOT) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: `slots[].slot cannot be '${PENDING_SLOT}' — that is the unresolved sentinel, not a slot`,
      });
    }
    return { id: e.id, slot: e.slot as string | null };
  });
}

function rowToFactRecord(row: FactRow): FactRecord {
  return {
    id: row.id,
    about: row.about,
    relation: row.relation,
    value: row.value,
    when: row.valid_start,
    provenance: row.provenance,
    // A STRING comparison — which is the second half of why the two validity
    // columns are `TEXT`. A `timestamptz` round-trip would hand back a `Date`
    // and this predicate would be true for every row, so every active row
    // would report `until`.
    ...(row.valid_end !== INFINITY_SENTINEL ? { until: row.valid_end } : {}),
    ...(row.closed_by !== null ? { closedBy: row.closed_by } : {}),
  };
}

/**
 * Run a STORE-ACCESS region and make sure any failure inside it leaves the
 * caller holding an error, never a plausible-looking empty answer (design
 * §4.4: "an empty table is a valid answer; a failed store is not"). Without
 * this, a `SELECT` that rejected mid-handler would propagate a raw
 * `DatabaseError`/`Error` that nothing downstream recognises as "the memory
 * was unreachable" — and the temptation on the calling side is always to
 * catch-and-continue with zero facts, which silently rewrites the user's
 * memory to empty.
 *
 * The postgres shape of "the store went away" is worth naming, because this
 * plugin does NOT own the pool: when `@ax/database-postgres` shuts down it
 * destroys the shared Kysely, and every later query rejects from Kysely's own
 * `RuntimeDriver` with a plain `Error('driver has already been destroyed')` —
 * no `code`, no plugin, nothing a caller could act on. That is precisely the
 * outage this wrapper is here to translate.
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
 *
 * ## One input the sqlite twin accepts and this backend cannot
 *
 * A string carrying U+0000 (a NUL byte). sqlite `TEXT` stores it; postgres
 * `TEXT` cannot hold it at all and the SERVER rejects the parameter with
 * SQLSTATE 22021 (`invalid byte sequence for encoding "UTF8": 0x00`). So a
 * `record` whose `about`/`relation`/`value`/`slot` contains a NUL succeeds on
 * sqlite and comes back here as `store-unavailable` — the same collapse the
 * second bullet above describes for any other constraint violation, applied to
 * an input the caller could plausibly send, since `about` is free text carrying
 * model output.
 *
 * Not "fixed" by rejecting NUL up front with `invalid-payload`: that would make
 * the two backends disagree about a payload the contract says is valid, which
 * is a worse divergence than the one it replaces. If a caller ever needs to
 * store NUL-bearing text, the fix is a decision for BOTH engines (reject at the
 * shared write door, or escape on the way in) — not a local patch here.
 */
async function inStore<T>(hookName: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
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
 * ## ⚠ TWO queries, never one-per-row
 *
 * `closes` is not a stored column — it is the inverse of `closed_by`. The
 * sqlite twin re-derives it with a prepared statement executed once per row
 * inside a `.map()`, which is free in-process and N NETWORK ROUND TRIPS here:
 * a 40-statement batch replay would be 41 queries against the shared
 * production database, inside an open transaction. So the inverse is fetched
 * for the WHOLE batch in one `closed_by IN (...)` read and grouped in memory.
 *
 * One honest difference from the first call's response: these are the rows as
 * they stand NOW, not a recording of what was returned then. A row that a
 * LATER statement closed comes back carrying `until`/`closedBy`, and `closes`
 * is whatever currently points at it. That is the more truthful answer — and
 * it is the only one available, since the original response was never stored.
 */
async function rebuildBatch(
  db: FactsDatabase,
  agentKey: string,
  batchKey: string,
): Promise<RecordedStatement[]> {
  const rows = (await db
    .selectFrom(TABLE)
    .selectAll()
    .where('agent_key', '=', agentKey)
    .where('batch_key', '=', batchKey)
    .orderBy('batch_seq')
    .execute()) as FactRow[];

  if (rows.length === 0) return [];

  // Tenant-scoped like every other read here. `closed_by` is ordered so the
  // grouped lists are stable run to run; the sqlite twin's per-row query has
  // no ORDER BY and is only incidentally stable.
  const closers = await db
    .selectFrom(TABLE)
    .select(['id', 'closed_by'])
    .where('agent_key', '=', agentKey)
    .where(
      'closed_by',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('id')
    .execute();

  const closesByRow = new Map<string, string[]>();
  for (const closer of closers) {
    if (closer.closed_by === null) continue;
    const bucket = closesByRow.get(closer.closed_by);
    if (bucket === undefined) closesByRow.set(closer.closed_by, [closer.id]);
    else bucket.push(closer.id);
  }

  return rows.map((row) => ({
    ...rowToFactRecord(row),
    closes: closesByRow.get(row.id) ?? [],
  }));
}

/**
 * `@ax/memory-facts-postgres` — postgres-backed peer of
 * `@ax/memory-facts-sqlite`.
 *
 * Same five hook contract (`runFactsContract` runs against both), different
 * backend. It uses the shared Kysely instance owned by `@ax/database-postgres`
 * via `database:get-instance`; per Invariant 2 it does NOT direct-import that
 * package at runtime — the bus is the only inter-plugin API.
 *
 * Deliberately NOT implemented here: free-text (`tsvector`/`pg_trgm`) and
 * dense (`pgvector`) recall. **The sqlite twin HAS had them since TASK-434**,
 * so this is a real asymmetry now rather than a shared gap: `recall` rejects a
 * `query` field with `invalid-payload` here and answers it there. The shared
 * contract is told so explicitly — this backend's factory declares no
 * `fusionRecall` capability, so the contract runs the rejection case against it
 * and the fusion cases against sqlite. TASK-457 owns building these channels
 * (and now has a sqlite implementation to match); TASK-458 owns the prior
 * question of whether pgvector exists in the image at all.
 */
export function createMemoryFactsPostgresPlugin(): Plugin {
  let db: Kysely<MemoryFactsDatabase> | undefined;

  /**
   * The one legal way to reach the shared Kysely from a handler.
   *
   * `db` is `undefined` before `init` — a bare `db!.selectFrom(...)` would
   * turn that into a `TypeError: Cannot read properties of undefined`, which
   * carries no code, no plugin name, and nothing to tell a caller apart from
   * a genuine bug in the handler. This is the same outage, said out loud.
   *
   * It deliberately does NOT try to detect a DESTROYED Kysely — there is no
   * public predicate for that, and guessing at one would be a second, quietly
   * different definition of "the store is down". A destroyed instance rejects
   * on use with a plain `Error`, and `inStore` turns that into the same
   * `store-unavailable` this throws.
   */
  function requireDb(): FactsDatabase {
    if (db === undefined) {
      throw new PluginError({
        code: 'store-unavailable',
        plugin: PLUGIN_NAME,
        message: 'the fact store is not open (plugin not initialised)',
      });
    }
    return db;
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
        'memory:facts:reindex',
      ],
      calls: ['database:get-instance'],
      subscribes: [],
    },

    async init({ bus }) {
      // bootstrap()'s topological order ensures database-postgres has already
      // registered `database:get-instance` before we run. Synthesize an init
      // context for log correlation; the underlying handler ignores it.
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      // The bus contract is Kysely<unknown>; we cast at the edge to our typed
      // schema. The shared instance IS just a Kysely over the pool — the type
      // param is a compile-time witness for which tables exist, namespaced by
      // our `memory_facts_v1` table name.
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<MemoryFactsDatabase>;
      await runFactsMigration(db);

      // Every handler derives the per-agent scope key from the calling ctx
      // so the single shared table is partitioned by agentId alone (mirrors
      // @ax/memory-facts-sqlite, and @ax/memory-strata-index-*'s TASK-257
      // partition). The hook I/O payloads stay unchanged — the key is
      // ambient (from ctx), never a wire field.
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

          const records = await inStore('memory:facts:record', async () => {
            const store = requireDb();

            // The WHOLE batch settles in ONE transaction (design §3.5). A
            // batch that died on statement 3 leaving 1 and 2 committed would
            // make a retry under the same `batchKey` see "already recorded"
            // and return a permanently half-written batch. Atomicity is what
            // makes the idempotency key safe, not a separate nicety.
            return store.transaction().execute(async (trx: FactsTransaction) => {
              // The dedup read lives INSIDE the transaction so the
              // check-then-write is not a race: two concurrent replays of the
              // same key cannot both decide the batch is new.
              //
              // "Rows exist for this key" IS the have-we-seen-it test. An
              // empty `statements` array therefore leaves no trace and stays
              // re-runnable forever — correct, because it stored nothing, so
              // there is nothing to be idempotent about.
              if (batchKey !== undefined) {
                const existing = await rebuildBatch(trx, agentKey, batchKey);
                if (existing.length > 0) return existing;
              }

              const written: RecordedStatement[] = [];
              // Sequential, not `Promise.all`: one transaction means one
              // connection, and each statement's closure decisions depend on
              // the rows the previous ones just wrote.
              for (const [index, statement] of statements.entries()) {
                const id = randomUUID();
                const closure = await insertWithSlotClosure(trx, agentKey, {
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

                written.push({
                  id,
                  about: statement.about,
                  relation: statement.relation,
                  value: statement.value,
                  when: statement.when,
                  provenance: statement.provenance ?? 'extracted',
                  closes: closure.closed,
                  ...(closure.selfClosedAt !== null ? { until: closure.selfClosedAt } : {}),
                  ...(closure.selfClosedBy !== null ? { closedBy: closure.selfClosedBy } : {}),
                });
              }
              return written;
            });
          });

          return { records };
        },
      );

      bus.registerService<RecallInput, RecallOutput>(
        'memory:facts:recall',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Validation before the store region — see `record`.
          const { about, ownerUserId, limit, activeOnly } = validateRecallInput(input);
          const agentKey = agentScopeKey(ctx);

          // `activeOnly` (§4.2 `history`) gates the validity predicate:
          // omitted/`true` keeps the TASK-421 behavior of only currently-
          // active rows; `false` drops the predicate entirely, so active AND
          // closed rows both come back. `input.query` is never consulted
          // here regardless — no FTS/dense/RRF/rerank on this backend. It is
          // rejected upstream in validation; TASK-457 owns adding it.
          //
          // Recall is the handler where swallowing a store failure would be
          // most tempting and most harmful: "no facts" and "could not read the
          // facts" render identically to the model, and one of them is a lie.
          // `degraded` is read from the SAME store region for the same
          // reason — a failed pending count must surface as `store-
          // unavailable`, not silently report a clean tenant.
          const { rows, degraded } = await inStore('memory:facts:recall', async () => {
            const store = requireDb();

            let query = store.selectFrom(TABLE).selectAll().where('agent_key', '=', agentKey);
            if (about !== undefined) query = query.where('about', '=', about);
            // Owner scope in the WHERE, never as a filter over the rows that
            // come back. The `.limit()` below is the whole argument: cut the
            // page first and filter after, and an owner whose rows are older
            // than another owner's gets a short answer — or an empty one —
            // while their rows sit there active and perfectly visible. Design
            // §6.1, "Never post-filter a widened pool", which lands hardest on
            // THIS backend: it is the one whose future dense channel (TASK-457)
            // will be a filtered ANN, where a widened-then-filtered pool is the
            // classic pgvector footgun the design already calls out.
            //
            // `=` is strict, and postgres's three-valued logic means a row with
            // `owner_user_id IS NULL` simply does not match. That is the
            // behaviour we want: unowned is not provably yours, and a scope may
            // only ever fail closed (Invariant 5).
            if (ownerUserId !== undefined) query = query.where('owner_user_id', '=', ownerUserId);
            if (activeOnly) query = query.where('valid_end', '=', INFINITY_SENTINEL);

            const rows = (await query
              .orderBy('valid_start', 'desc')
              // A tiebreak the sqlite twin does not have, and that no contract
              // case can observe (every multi-row ordering assertion there
              // uses distinct `when`s, or sorts). It is here because postgres
              // promises NO order for rows tied on `valid_start` — under a
              // `LIMIT` that is a nondeterministic result SET, not just a
              // nondeterministic order. sqlite happens to be stable by rowid;
              // this makes the same promise on purpose.
              .orderBy('id', 'desc')
              .limit(limit)
              .execute()) as FactRow[];

            return { rows, degraded: (await pendingStatus(store, agentKey)).degraded };
          });

          return { statements: rows.map(rowToFactRecord), degraded };
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
          // Same rule and same reason as `recall`'s: `''` is storable, so
          // treating it as absent would turn "close only MY rows" into "close
          // any row in the tenant" — a scope failing OPEN, on the one hook
          // that destroys state.
          if (input.ownerUserId !== undefined && !isNonEmptyString(input.ownerUserId)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'ownerUserId must be a non-empty string when set',
            });
          }
          const agentKey = agentScopeKey(ctx);
          const at = new Date().toISOString();
          // A supersede that silently did nothing is indistinguishable from
          // one whose ids were all foreign — `closed: []` is a legitimate
          // answer here, so a store failure MUST be an error instead. Same
          // for `resettled: []`, which is the ordinary answer whenever the
          // retracted rows had closed nothing.
          //
          // `supersedeIds` owns the transaction that spans the retraction AND
          // the re-settle of the chains it invalidated (TASK-448), so this
          // handler hands its result straight out: `SupersedeResult` and
          // `SupersedeOutput` are the same two fields, one in engine terms and
          // one in the hook's.
          return inStore('memory:facts:supersede', () =>
            supersedeIds(requireDb(), agentKey, input.ids, at, input.ownerUserId),
          );
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
          await inStore('memory:facts:clear', async () => {
            await requireDb().deleteFrom(TABLE).where('agent_key', '=', agentKey).execute();
          });
        },
      );

      bus.registerService<ReindexInput, ReindexOutput>(
        'memory:facts:reindex',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Validation before the store region — see `record`.
          const slots = validateReindexInput(input);
          const agentKey = agentScopeKey(ctx);

          return inStore('memory:facts:reindex', async () => {
            const store = requireDb();

            // ONE transaction for the whole drain. Writing a resolved slot and
            // re-settling the chain that row just joined are halves of the
            // same operation: a crash between them would leave a real-slot row
            // sitting in a chain that had never been re-derived, which reads
            // as two simultaneously-active values for one slot — the exact
            // corruption pending exists to avoid. It is also what makes the
            // reported `resolved`/`resettled`/`pending` numbers describe one
            // consistent snapshot rather than three moments.
            return store.transaction().execute(async (trx: FactsTransaction) => {
              let resolved = 0;
              // Deduped by `(about, slot)`: two rows resolved into the same
              // chain re-derive it once, not twice. A Map keyed structurally
              // (`JSON.stringify([about, slot])`), not by joining the two
              // fields with a delimiter: `about` is free text that can carry
              // model output, and ANY in-band delimiter is only injective if
              // the fields are guaranteed not to contain it, which nothing
              // here guarantees. `about = "x\u0001y", slot = "z"` and `about
              // = "x", slot = "y\u0001z"` produce the same joined string but
              // different JSON arrays (same reasoning as `supersedeIds`'s
              // group map in `closure.ts`).
              const groups = new Map<string, SlotGroup>();

              for (const entry of slots) {
                // Find-and-resolve in ONE statement, with `RETURNING` as the
                // authority on whether anything moved. The sqlite twin SELECTs
                // then UPDATEs and reads `.changes === 0`; Kysely's postgres
                // equivalent, `numUpdatedRows`, is a **bigint**, so `=== 0`
                // against a number is ALWAYS false and every entry would look
                // resolved — inflating `resolved` and re-settling chains that
                // never changed. `RETURNING` cannot be got wrong that way, and
                // it halves the round trips.
                //
                // Tenant-scoped AND still-pending, in one predicate: a foreign
                // id, a missing id, and an already-resolved id are all just "no
                // row", and all three are silently ignored — the same forgiving
                // shape `supersede` has, because the caller is draining a list
                // it built earlier and a racing second drain is normal. A
                // repeated id in one call therefore resolves ONCE: the second
                // occurrence no longer finds a pending row. First entry wins,
                // deterministically.
                const touched = await trx
                  .updateTable(TABLE)
                  .set({ slot: entry.slot })
                  .where('id', '=', entry.id)
                  .where('agent_key', '=', agentKey)
                  .where('slot', '=', PENDING_SLOT)
                  .returning('about')
                  .execute();

                if (touched.length === 0) continue;
                resolved += touched.length;
                // `slot: null` is "no slot after all" — the row is inert
                // forever, joins no chain, and so touches nothing to re-settle.
                if (entry.slot !== null) {
                  const about = touched[0]!.about;
                  groups.set(JSON.stringify([about, entry.slot]), { about, slot: entry.slot });
                }
              }

              const resettled = await resettleSlotGroups(trx, agentKey, [...groups.values()]);
              // Counted AFTER the writes, inside the same transaction, so the
              // number is the state this call left behind — not the one it
              // found. Called with no `slots` this is the whole hook: a status
              // read (design §2.2). A whole-tenant repair sweep is deliberately
              // NOT built — it has no caller (plan §6).
              return { resolved, resettled, ...(await pendingStatus(trx, agentKey)) };
            });
          });
        },
      );
    },

    // NO shutdown() — the shared Kysely instance is owned and destroyed by
    // @ax/database-postgres. Calling db.destroy() here would tear down the
    // pool for every other postgres-backed plugin in the process.
  };
}
