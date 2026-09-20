import { randomUUID } from 'node:crypto';
import { PluginError, type AgentContext, type HookBus, type Plugin } from '@ax/core';
import type {
  RecordInput,
  RecordOutput,
  RecordedStatement,
  FactStatementInput,
  RecallInput,
  RecallOutput,
  FactRecord,
  DegradedFlag,
  SupersedeInput,
  SupersedeOutput,
  ClearInput,
  Provenance,
  ReindexInput,
  ReindexOutput,
  ResolvedSlot,
} from '@ax/memory-facts-contract';
import {
  openDatabase,
  indexFactRow,
  deleteIndexedFactRows,
  EMBEDDING_DIMENSIONS,
  TABLE,
  FTS_TABLE,
  VEC_TABLE,
  INFINITY_SENTINEL,
  type FactRow,
} from './schema.js';
import {
  insertWithSlotClosure,
  resettleSlotGroups,
  supersedeIds,
  type SlotGroup,
} from './closure.js';
import { PENDING_SLOT, pendingStatus, semanticStatus, rankingStatus } from './pending.js';
import {
  buildFtsMatchQuery,
  denseChannel,
  factStatementText,
  reciprocalRankFusion,
  rowsInRankOrder,
  sparseChannel,
  temporalChannel,
  CHANNEL_LIMIT,
  POOL_SIZE,
  type ChannelScope,
} from './recall.js';
import { embedTexts, rerankDocuments, type ProducerRef } from './producers.js';
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

function validateRecallInput(input: RecallInput): {
  about?: string;
  query?: string;
  limit: number;
  poolSize: number;
  activeOnly: boolean;
} {
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
  // `query` IS implemented here (TASK-434) — this engine declares
  // `capabilities.fusionRecall`. An EMPTY query is still rejected rather than
  // treated as absent: `''` is falsy in JS but a perfectly good value on the
  // wire, and silently answering it with the recency listing would hand a
  // caller who thought they were searching an unfiltered result set dressed up
  // as a search. Same reasoning as the empty-`batchKey` rejection above.
  if (input.query !== undefined && !isNonEmptyString(input.query)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'query must be a non-empty string when set',
    });
  }
  if (
    input.poolSize !== undefined &&
    (typeof input.poolSize !== 'number' || !Number.isFinite(input.poolSize) || input.poolSize < 1)
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'poolSize must be a positive number when set',
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
    ...(input.query !== undefined ? { query: input.query } : {}),
    limit: Math.min(Math.floor(input.limit), MAX_LIMIT),
    // Clamped by the same ceiling as `limit`, for the same reason: this one
    // sizes the payload handed to a third-party reranker, so an unbounded
    // value would be an unbounded outbound request carrying memory content.
    poolSize: Math.min(Math.floor(input.poolSize ?? POOL_SIZE), MAX_LIMIT),
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
  /**
   * Which service hook produces embeddings, and optionally which model to ask
   * it for. Absent — the default today, since no provider plugin ships yet —
   * means the dense channel never runs and every `query` recall reports
   * `degraded: ['semantic']` (design §4.4). See `producers.ts`.
   *
   * A hook NAME rather than a function, deliberately: it makes this read-path
   * embedder and §3.3's write-path (slot-normalization) one the SAME seam —
   * one provider, one credential, one egress host.
   */
  embedder?: ProducerRef;
  /**
   * Which service hook reranks a candidate pool. Absent means the fused order
   * stands and every `query` recall reports `degraded: ['ranking']`.
   */
  reranker?: ProducerRef;
}

/**
 * Ceiling on how many rows ONE `memory:facts:reindex` call re-derives.
 *
 * Backfill exists because rows recorded before a provider (or before
 * TASK-434's tables) would otherwise be permanently invisible to the sparse
 * and dense channels. It is bounded because the vector half makes an outbound
 * call per chunk, and an unbounded sweep over a large tenant would sit inside
 * one hook call until the bus timed it out — leaving nothing committed. The
 * drain is re-runnable, so a big backlog clears over several calls.
 */
const BACKFILL_LIMIT = 200;

/** Texts per embed call during backfill — one bounded request, not one per row. */
const BACKFILL_EMBED_CHUNK = 32;

export function createMemoryFactsSqlitePlugin(config: MemoryFactsSqliteConfig): Plugin {
  let driver: BetterSqliteDb | undefined;
  // Set by `openDatabase`: whether THIS connection can use `VEC_TABLE`. The
  // dense channel's availability is a property of the host (is there a
  // prebuilt `sqlite-vec` binary for it?), not of any one call, so it is read
  // once at init and threaded everywhere instead of being re-derived — or,
  // as it was before, discovered by letting a write fail.
  let vectorExtensionLoaded = false;

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

  /**
   * The `query` half of `memory:facts:recall` — three channels, RRF, an
   * optional rerank (design §2.3), ported from `dem-memory`'s `RecallEngine`.
   *
   * The interleaving of async producer calls and synchronous store regions is
   * the shape of the whole function, so it is worth naming: better-sqlite3 is
   * synchronous and nothing may be awaited inside a transaction, while both
   * producers are network calls. So it runs embed (async) → channels + fetch
   * (one store region) → rerank (async) → reorder (pure). The store region
   * fetches the rows for EVERY fused candidate rather than only the page that
   * will be returned, which is what lets the rerank reorder without a second
   * read — and a second read taken after an awaited rerank could see a
   * different store than the one the ranking was computed over.
   */
  async function fusionRecall(
    bus: HookBus,
    ctx: AgentContext,
    args: {
      agentKey: string;
      query: string;
      about?: string;
      limit: number;
      poolSize: number;
      activeOnly: boolean;
    },
  ): Promise<RecallOutput> {
    const scope: ChannelScope = {
      agentKey: args.agentKey,
      activeOnly: args.activeOnly,
      limit: CHANNEL_LIMIT,
      ...(args.about !== undefined ? { about: args.about } : {}),
    };

    // No vec0 on this host means no dense channel whatever the embedder says,
    // so the call is not even attempted — an outbound request carrying memory
    // content whose answer has nowhere to go is pure cost and pure exposure.
    // Both roads lead to the same `'semantic'`.
    const queryVectors = vectorExtensionLoaded
      ? await embedTexts(bus, ctx, config.embedder, [args.query], 'query', EMBEDDING_DIMENSIONS)
      : undefined;
    const queryVector = queryVectors?.[0];
    const denseContributed = queryVector !== undefined;

    const { fusedRows, pendingFlags } = inStore('memory:facts:recall', () => {
      const db = requireDriver();

      // The sanitizer returns null when nothing survives tokenizing; that is
      // "the sparse channel found nothing", not an error.
      const match = buildFtsMatchQuery(args.query);
      const sparse = match === null ? [] : sparseChannel(db, { ...scope, match });
      const dense = queryVector === undefined ? [] : denseChannel(db, scope, queryVector);
      const temporal = temporalChannel(db, scope);

      // Unweighted, k = 60, three channels — `dem-memory`'s constants exactly,
      // taken from the contract so postgres cannot drift (TASK-457). The graph
      // channel is ABSENT rather than an empty list: it was ablated at rung 0
      // and deleted upstream in #587, and passing `[]` for it would change
      // nothing while implying it might come back.
      const fused = reciprocalRankFusion([sparse, dense, temporal]);
      return {
        fusedRows: rowsInRankOrder<FactRow>(
          db,
          args.agentKey,
          fused.map((c) => c.id),
        ),
        pendingFlags: pendingStatus(db, args.agentKey).degraded,
      };
    });

    // Rerank the head of the fused list and leave the tail in raw RRF order —
    // the reference implementation's behaviour, and the reason `poolSize`
    // wants raising alongside a raised `limit` rather than being left at its
    // default while a long answer runs off the end of the reranked pool.
    const pool = fusedRows.slice(0, args.poolSize);
    const scores = await rerankDocuments(
      bus,
      ctx,
      config.reranker,
      args.query,
      pool.map((row) => factStatementText(row.about, row.relation, row.value)),
    );
    const ranked =
      scores === undefined
        ? fusedRows
        : [
            ...pool
              .map((row, index) => ({ row, score: scores[index] ?? 0 }))
              // `id.localeCompare` on ties for the same reason RRF has it: a
              // reranker that returns equal scores must not leave the order to
              // whatever `sort` stability happens to hand us.
              .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
              .map((entry) => entry.row),
            ...fusedRows.slice(args.poolSize),
          ];

    // ONE array, assembled in ONE place out of independent probes
    // (Invariant 4). APPENDED to the pending flags, never substituted for
    // them: a caller that already depends on `'pending'` must not lose it the
    // moment it starts passing a `query`.
    const degraded: DegradedFlag[] = [
      ...pendingFlags,
      ...semanticStatus(denseContributed),
      ...rankingStatus(scores !== undefined),
    ];
    return { statements: ranked.slice(0, args.limit).map(rowToFactRecord), degraded };
  }

  /**
   * Re-derive the sparse (and, when an embedder is configured, dense) index
   * rows for facts that have none — `memory:facts:reindex`'s other half.
   *
   * It is `reindex`'s job rather than a new hook because that hook already
   * promises to rebuild derived indexes, and because there are exactly two
   * ways a fact ends up unindexed and both are ordinary: it was recorded
   * before TASK-434 added the tables, or it was recorded while no embedder
   * was configured. Without this those rows are permanently invisible to the
   * two channels that rank by relevance — present in the store, unreachable
   * by search.
   *
   * Bounded at {@link BACKFILL_LIMIT} rows per call and re-runnable; see that
   * constant for why an unbounded sweep would be worse than a partial one.
   * Everything here is tenant-scoped like every other read in this plugin.
   */
  async function backfillDerivedIndexes(
    bus: HookBus,
    ctx: AgentContext,
    agentKey: string,
  ): Promise<void> {
    const missingFts = inStore('memory:facts:reindex', () => {
      const db = requireDriver();
      // One scan of each side and a set difference, rather than a correlated
      // `NOT EXISTS` per row: an FTS5 table has no index on `id` (it is
      // UNINDEXED — a join key, never a search term), so the per-row form is
      // a full scan of the shadow table for every fact in the tenant.
      const indexed = new Set(
        (db.prepare(`SELECT id FROM ${FTS_TABLE}`).all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      );
      return (
        db
          .prepare(`SELECT id, about, relation, value FROM ${TABLE} WHERE agent_key = ?`)
          .all(agentKey) as Array<{
          id: string;
          about: string;
          relation: string;
          value: string;
        }>
      )
        .filter((row) => !indexed.has(row.id))
        .slice(0, BACKFILL_LIMIT);
    });

    if (missingFts.length > 0) {
      inStore('memory:facts:reindex', () => {
        const db = requireDriver();
        const writeAll = db.transaction(() => {
          for (const row of missingFts) indexFactRow(db, row, { vectorExtensionLoaded });
        });
        writeAll();
      });
    }

    if (config.embedder === undefined || !vectorExtensionLoaded) return;

    const missingVectors = inStore('memory:facts:reindex', () => {
      const db = requireDriver();
      const embedded = new Set(
        (db.prepare(`SELECT id FROM ${VEC_TABLE}`).all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      );
      return (
        db
          .prepare(`SELECT id, about, relation, value FROM ${TABLE} WHERE agent_key = ?`)
          .all(agentKey) as Array<{
          id: string;
          about: string;
          relation: string;
          value: string;
        }>
      )
        .filter((row) => !embedded.has(row.id))
        .slice(0, BACKFILL_LIMIT);
    });

    for (let start = 0; start < missingVectors.length; start += BACKFILL_EMBED_CHUNK) {
      const chunk = missingVectors.slice(start, start + BACKFILL_EMBED_CHUNK);
      const vectors = await embedTexts(
        bus,
        ctx,
        config.embedder,
        chunk.map((row) => factStatementText(row.about, row.relation, row.value)),
        'document',
        EMBEDDING_DIMENSIONS,
      );
      // The producer did not answer. Stop rather than hammering it for every
      // remaining chunk: the backlog is still there and the next `reindex`
      // call picks it up, which is the same degradation as never having had a
      // provider at all.
      if (vectors === undefined) return;
      inStore('memory:facts:reindex', () => {
        const db = requireDriver();
        const writeAll = db.transaction(() => {
          chunk.forEach((row, index) => {
            const vector = vectors[index];
            if (vector === undefined) return;
            indexFactRow(db, row, { vector, vectorExtensionLoaded });
          });
        });
        writeAll();
      });
    }
  }

  // Declared only when CONFIGURED, the same shape `@ax/llm-anthropic` uses for
  // `credentials:get`: a deployment that never sets `embedder` has no business
  // advertising a dependency on a hook it will never call, and a deployment
  // that does gets the gap documented at the manifest level rather than buried
  // in a comment. `bootstrap.ts`'s `verifyCalls` deliberately skips
  // `optionalCalls`, so an absent producer is non-fatal at boot — which is
  // also what keeps this plugin out of the preset canaries' `PLUGINS_TO_DROP`.
  const optionalCalls = [
    ...(config.embedder !== undefined
      ? [
          {
            hook: config.embedder.hook,
            degradation:
              "the dense (semantic) recall channel does not run: `memory:facts:recall` answers a `query` from the lexical and recency channels alone and reports degraded: ['semantic']; newly recorded facts store no vector, and `memory:facts:reindex` backfills them once a producer exists",
          },
        ]
      : []),
    ...(config.reranker !== undefined
      ? [
          {
            hook: config.reranker.hook,
            degradation:
              "the rerank step does not run: `memory:facts:recall` returns candidates in fused-rank order instead of reranked order and reports degraded: ['ranking']",
          },
        ]
      : []),
  ];

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
      calls: [],
      ...(optionalCalls.length > 0 ? { optionalCalls } : {}),
      subscribes: [],
    },

    init({ bus }) {
      const opened = openDatabase(config.databasePath);
      driver = opened.driver;
      vectorExtensionLoaded = opened.vectorExtensionLoaded;

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

          // Embed BEFORE the store region, because better-sqlite3's
          // transactions are synchronous and nothing may be awaited inside
          // one. The engine owns the `vec0` table, so it owns DOCUMENT
          // embedding too (task `document`, as against `recall`'s `query`) —
          // a different use of the same seam from §3.3's slot normalizer,
          // which stays in `@ax/memory`.
          //
          // `undefined` here is the ordinary no-provider case, not a failure:
          // the rows are stored without vectors and `reindex` backfills them
          // if a provider appears. One honest cost: an idempotent REPLAY of a
          // batch pays for an embed call whose result the dedup path then
          // discards. Avoiding it would mean reading the dedup row outside the
          // transaction, which is exactly the check-then-write race that
          // transaction was moved inward to close.
          const vectors = vectorExtensionLoaded
            ? await embedTexts(
                bus,
                ctx,
                config.embedder,
                statements.map((s) => factStatementText(s.about, s.relation, s.value)),
                'document',
                EMBEDDING_DIMENSIONS,
              )
            : undefined;

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

                // Derived indexes are written INSIDE the batch transaction, so
                // a fact and its searchability commit or roll back together —
                // design §1's "record is atomic across relational + FTS +
                // vector". A row that existed but could not be found would be
                // the worst of both.
                indexFactRow(
                  db,
                  {
                    id,
                    about: statement.about,
                    relation: statement.relation,
                    value: statement.value,
                  },
                  {
                    vectorExtensionLoaded,
                    ...(vectors?.[index] !== undefined ? { vector: vectors[index] } : {}),
                  },
                );

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
          const { about, query, limit, poolSize, activeOnly } = validateRecallInput(input);
          const agentKey = agentScopeKey(ctx);

          if (query !== undefined) {
            return fusionRecall(bus, ctx, {
              agentKey,
              query,
              limit,
              poolSize,
              activeOnly,
              ...(about !== undefined ? { about } : {}),
            });
          }

          // `activeOnly` (§4.2 `history`) gates the validity predicate:
          // omitted/`true` keeps the TASK-421 behavior of only currently-
          // active rows; `false` drops the predicate entirely, so active AND
          // closed rows both come back. This is the LISTING path — no `query`,
          // therefore no channels, therefore nothing that could degrade beyond
          // `'pending'`. Raising `'semantic'`/`'ranking'` here would be noise:
          // no dense channel was skipped, because none was asked for.
          //
          // Recall is the handler where swallowing a store failure would be
          // most tempting and most harmful: "no facts" and "could not read the
          // facts" render identically to the model, and one of them is a lie.
          // `degraded` is read from the SAME store region for the same
          // reason — a failed pending count must surface as `store-
          // unavailable`, not silently report a clean tenant.
          const { rows, degraded } = inStore('memory:facts:recall', () => {
            const db = requireDriver();

            const conditions = ['agent_key = ?'];
            const params: unknown[] = [agentKey];
            if (about !== undefined) {
              conditions.push('about = ?');
              params.push(about);
            }
            if (activeOnly) {
              conditions.push('valid_end = ?');
              params.push(INFINITY_SENTINEL);
            }
            params.push(limit);

            // `, id DESC` is a tiebreak the postgres twin needed and this one
            // gets for parity (Invariant 4 — two backends behind one contract
            // must not differ in ways the contract cannot see). SQLite has no
            // documented promise about row order for rows tied on
            // `valid_start` either; it is only STABLE by rowid in practice,
            // which is an implementation detail, not a guarantee. Under a
            // `LIMIT` a nondeterministic order is a nondeterministic result
            // SET, not merely a nondeterministic order, so this closes the
            // same gap postgres's `.orderBy('id', 'desc')` does — no contract
            // case can observe it (see the sibling comment there).
            const rows = db
              .prepare(
                `SELECT * FROM ${TABLE}
                WHERE ${conditions.join(' AND ')}
                ORDER BY valid_start DESC, id DESC LIMIT ?`,
              )
              .all(...params) as FactRow[];

            return { rows, degraded: pendingStatus(db, agentKey).degraded };
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
            supersedeIds(requireDriver(), agentKey, input.ids, at),
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
          inStore('memory:facts:clear', () => {
            const db = requireDriver();
            // The derived rows go too, in the same transaction. Everywhere
            // else the FTS shadow is left alone when a fact stops being
            // current — that is a VALIDITY question and the base table is its
            // sole authority (Invariant 4), so the join at query time settles
            // it. Clear is not a validity question: the base row is gone, so
            // the join would hide the text either way, and leaving the
            // tenant's statements sitting in a shadow table after they asked
            // us to forget them is a retention bug rather than a ranking one.
            const forget = db.transaction(() => {
              const ids = (
                db.prepare(`SELECT id FROM ${TABLE} WHERE agent_key = ?`).all(agentKey) as Array<{
                  id: string;
                }>
              ).map((row) => row.id);
              deleteIndexedFactRows(db, ids, vectorExtensionLoaded);
              db.prepare(`DELETE FROM ${TABLE} WHERE agent_key = ?`).run(agentKey);
            });
            forget();
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

          const drained = inStore('memory:facts:reindex', () => {
            const db = requireDriver();

            // ONE transaction for the whole drain. Writing a resolved slot and
            // re-settling the chain that row just joined are halves of the
            // same operation: a crash between them would leave a real-slot row
            // sitting in a chain that had never been re-derived, which reads
            // as two simultaneously-active values for one slot — the exact
            // corruption pending exists to avoid. It is also what makes the
            // reported `resolved`/`resettled`/`pending` numbers describe one
            // consistent snapshot rather than three moments.
            const drain = db.transaction((): ReindexOutput => {
              // Tenant-scoped AND still-pending, in one predicate: a foreign
              // id, a missing id, and an already-resolved id are all just "no
              // row", and all three are silently ignored — the same forgiving
              // shape `supersede` has, because the caller is draining a list
              // it built earlier and a racing second drain is normal.
              const findPending = db.prepare(
                `SELECT about FROM ${TABLE} WHERE id = ? AND agent_key = ? AND slot = ?`,
              );
              const resolveSlot = db.prepare(
                `UPDATE ${TABLE} SET slot = ? WHERE id = ? AND agent_key = ? AND slot = ?`,
              );

              let resolved = 0;
              // Deduped by `(about, slot)`: two rows resolved into the same
              // chain re-derive it once, not twice. A Map keyed structurally
              // (`JSON.stringify([about, slot])`), not by joining the two
              // fields with a delimiter: `about` is free text that can carry
              // model output, and ANY in-band delimiter — including NUL — is
              // only injective if the fields are guaranteed not to contain
              // it, which nothing here guarantees. `about = "x\u0000y", slot
              // = "z"` and `about = "x", slot = "y\u0000z"` produce the same
              // NUL-joined string but different JSON arrays (same reasoning
              // as `supersedeIds`'s group map in `closure.ts`).
              const groups = new Map<string, SlotGroup>();

              for (const entry of slots) {
                const row = findPending.get(entry.id, agentKey, PENDING_SLOT) as
                  | { about: string }
                  | undefined;
                if (row === undefined) continue;
                // A repeated id in one call therefore resolves ONCE: the
                // second occurrence no longer finds a pending row. First
                // entry wins, deterministically.
                const { changes } = resolveSlot.run(entry.slot, entry.id, agentKey, PENDING_SLOT);
                if (changes === 0) continue;
                resolved += changes;
                // `slot: null` is "no slot after all" — the row is inert
                // forever, joins no chain, and so touches nothing to re-settle.
                if (entry.slot !== null) {
                  groups.set(JSON.stringify([row.about, entry.slot]), {
                    about: row.about,
                    slot: entry.slot,
                  });
                }
              }

              const resettled = resettleSlotGroups(db, agentKey, [...groups.values()]);
              // Counted AFTER the writes, inside the same transaction, so the
              // number is the state this call left behind — not the one it
              // found. Called with no `slots` this is the whole hook: a status
              // read (design §2.2). A whole-tenant repair sweep is deliberately
              // NOT built — it has no caller (plan §6).
              return { resolved, resettled, ...pendingStatus(db, agentKey) };
            });

            return drain();
          });

          // The index backfill runs AFTER the drain and outside its
          // transaction, because embedding is an awaited network call and a
          // better-sqlite3 transaction is synchronous. It is deliberately not
          // reported in the return payload: `ReindexOutput`'s three numbers
          // describe the pending drain, which is one consistent snapshot taken
          // inside one transaction, and folding in a count from a later,
          // separately-committed pass would quietly break that promise.
          await backfillDerivedIndexes(bus, ctx, agentKey);

          return drained;
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
