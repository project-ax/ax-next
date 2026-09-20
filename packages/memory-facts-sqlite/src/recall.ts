// The three retrieval channels behind `memory:facts:recall`'s `query`, ported
// from `dem-memory/src/engine/recall.ts` + `src/db/memory-repository.ts` with
// the column names this store actually uses (`about`/`relation`/`value`,
// `agent_key` — not `subject`/`predicate`/`object`, `bank_id`). The graph
// channel is NOT ported: it was ablated at rung 0 (identical coverage on/off
// across three runs and two rerankers) and deleted from `dem-memory` in #587.
//
// Faithfulness is the point, not taste. Rung 4 re-measures this engine against
// the numbers rung 1 produced, so a channel that admits differently, an
// ORDER BY with a different orientation, or a re-tuned fusion constant would
// make that comparison answer a different question. Where this file departs
// from the reference it says so and why.
//
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { TABLE, FTS_TABLE, VEC_TABLE, INFINITY_SENTINEL, vectorToBlob } from './schema.js';

// ---------------------------------------------------------------------------
// Fusion — DUPLICATED from `@ax/memory-facts-contract`, deliberately
// ---------------------------------------------------------------------------
//
// The spelling of record for RRF and its constants is the contract package, so
// that TASK-457's postgres engine fuses identically and the contract's ordering
// cases mean the same thing on both (Invariant 4). This is a COPY of it, for
// the same reason `PENDING_SLOT` is copied into `pending.ts`: that package
// ships the shared vitest suite and therefore depends on `vitest` at RUNTIME,
// so it is a devDependency here and `eslint`'s `no-restricted-imports` blocks
// importing a VALUE from it (Invariant 2 — cross-plugin runtime imports are
// forbidden). `import type` is erased and costs nothing; importing the
// function would drag a test runner into this plugin's production graph.
//
// The drift this obviously risks is closed the way the `PENDING_SLOT` one is:
// `__tests__/rrf-parity.test.ts` imports BOTH and asserts they agree, on
// constants and on output including the tie case. A divergence is a failing
// test, not a silent split where two engines rank differently behind one
// contract.

/**
 * RRF's rank-damping constant. 60 is the value `dem-memory` measured with, and
 * rung 4 re-measures this engine against those numbers — a retuned `k` would
 * make that comparison meaningless, so it is a constant and not config.
 */
export const RRF_K = 60;

/** How many candidates one channel contributes to the fusion. */
export const CHANNEL_LIMIT = 40;

/** How many fused candidates the rerank step reorders; the tail keeps raw RRF order. */
export const POOL_SIZE = 40;

/** One fused candidate: a row id and its summed reciprocal-rank score. */
export interface FusedCandidate {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion over any number of ranked id lists, best-first.
 *
 * `score += 1 / (k + rank + 1)` with a 0-BASED rank, summed across lists and
 * UNWEIGHTED — every channel counts the same, which is what lets two channels
 * agreeing on a mediocre row outrank one channel's single best hit.
 *
 * Ties are broken by ascending id, and that tiebreak is load-bearing rather
 * than cosmetic: `Array.prototype.sort` is stable, so without it the order of
 * two equally-scored rows is whatever order the channels happened to be passed
 * in. (The in-repo bench copy at
 * `packages/memory-strata/test/bench/configs/c-rrf.ts` omits it; this is the
 * port of `dem-memory/src/engine/recall.ts`, which does not.)
 */
export function reciprocalRankFusion(lists: string[][], k: number = RRF_K): FusedCandidate[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * The text a channel or a reranker sees for one fact — ported from
 * `dem-memory`'s `memoryStatement`, underscores spelled out as words so a
 * `likes_artist` relation reads as language to an embedder or a cross-encoder
 * rather than as one out-of-vocabulary token.
 */
export function factStatementText(about: string, relation: string, value: string): string {
  const words = (v: string): string => v.replace(/_/g, ' ').trim();
  return `${words(about)} ${words(relation)}: ${value.trim()}`;
}

/**
 * Turn untrusted free text into an FTS5 MATCH expression, ported verbatim in
 * behaviour from `dem-memory`'s `buildFtsMatchQuery`.
 *
 * Every token is extracted with `[\p{L}\p{N}]+` — so every FTS5 operator
 * character (`-`, `*`, `^`, `:`, `"`, `(`, `)`, `NEAR`-adjacent punctuation) is
 * simply not part of any token — then QUOTED, which makes even a bare-word
 * operator like `OR` a literal term. That double guard is the point: query
 * text reaches this engine as model or user output through `@ax/memory`, and a
 * parser that honours operators in raw input INVERTS the query — unescaped,
 * `-graduated` matches every row LACKING the term. The contract pins this
 * (`memory-strata-index-contract`'s Test 8c pins the same class on the
 * document index); design §6.3 lists "FTS operators neutralized" as an
 * injection control.
 *
 * Deduped so a repeated word cannot weight itself, and capped at 24 tokens so
 * a pathological query cannot build an unbounded OR-tree. Returns `null` when
 * nothing survives — the caller treats that as "the sparse channel found
 * nothing", never as an error.
 */
export const MAX_MATCH_TOKENS = 24;

export function buildFtsMatchQuery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const cleaned = [...new Set(tokens.map((t) => t.replace(/"/g, '')).filter(Boolean))].slice(
    0,
    MAX_MATCH_TOKENS,
  );
  if (cleaned.length === 0) return null;
  return cleaned.map((token) => `"${token}"`).join(' OR ');
}

/**
 * The filters that apply to every channel identically, because they are the
 * caller's, not the ranking's: tenant scope, the optional `about` narrowing,
 * and `activeOnly`.
 *
 * `dem-memory` has a `temporalAnchor` here instead of `activeOnly`; §4.2
 * deliberately keeps point-in-time travel off this surface, so the validity
 * predicate is the binary one the filtered listing already uses.
 */
export interface ChannelScope {
  agentKey: string;
  about?: string;
  /**
   * The caller's owner scope, or absent for "every owner in this tenant" —
   * the hook's `ownerUserId`, which is a SCOPE and not a hint (design §6.1).
   * It sits here, on the scope every channel already takes, precisely so no
   * channel can be written without it: `scopeFilter` is the one place the
   * predicate is spelled, and all three channels go through it.
   */
  ownerUserId?: string;
  activeOnly: boolean;
  limit: number;
}

interface ValidityFilter {
  sql: string;
  params: unknown[];
}

function scopeFilter(scope: ChannelScope, alias: string): ValidityFilter {
  const prefix = alias === '' ? '' : `${alias}.`;
  const sql = [`${prefix}agent_key = ?`];
  const params: unknown[] = [scope.agentKey];
  if (scope.about !== undefined) {
    sql.push(`${prefix}about = ?`);
    params.push(scope.about);
  }
  // Owner scope, ANDed into the channel's OWN predicate rather than applied to
  // the rows it returns. Post-filtering would be wrong twice over. First,
  // `scope.limit` is the channel's contribution to the fusion: filter after
  // the LIMIT and an owner whose rows happen to rank below another owner's
  // contributes NOTHING to a fusion that had forty slots available — design
  // §6.1's "Never post-filter a widened pool", which is a correctness rule
  // here and not a performance one. Second, a post-filter is a filter someone
  // has to remember to write at each of the three call sites; this is the one
  // place all three already go through.
  //
  // Strict `=`, so a row with `owner_user_id IS NULL` does not match — SQL's
  // three-valued logic gives that for free, and it is the behaviour we want:
  // unowned is not provably yours (Invariant 5, fail closed).
  if (scope.ownerUserId !== undefined) {
    sql.push(`${prefix}owner_user_id = ?`);
    params.push(scope.ownerUserId);
  }
  if (scope.activeOnly) {
    sql.push(`${prefix}valid_end = ?`);
    params.push(INFINITY_SENTINEL);
  }
  return { sql: sql.join(' AND '), params };
}

/**
 * Sparse (lexical) channel — FTS5 over the shadow table, best first.
 *
 * `ORDER BY bm25(...)` with no negation and no DESC: SQLite's `bm25()` is
 * already oriented so that a better match is a SMALLER (more negative) value,
 * so ascending IS best-first. We rank by it rather than surfacing it, which is
 * why no normalization is needed either — RRF only ever reads positions.
 *
 * The JOIN back to `TABLE` is what keeps the base table the sole authority on
 * validity (Invariant 4): the FTS row for a superseded fact is still there and
 * still matches, and this predicate is the only thing that decides whether it
 * counts.
 */
export function sparseChannel(
  driver: BetterSqliteDb,
  scope: ChannelScope & { match: string },
): string[] {
  const filter = scopeFilter(scope, 'm');
  const rows = driver
    .prepare(
      `SELECT m.id AS id
         FROM ${FTS_TABLE} f JOIN ${TABLE} m ON m.id = f.id
        WHERE ${FTS_TABLE} MATCH ? AND ${filter.sql}
        ORDER BY bm25(${FTS_TABLE})
        LIMIT ?`,
    )
    .all(scope.match, ...filter.params, scope.limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * How much the dense channel over-fetches before the validity filter runs.
 *
 * `vec0` takes `MATCH` plus `k` and nothing else — no arbitrary predicate can
 * ride along — so tenant scope, `about` and `activeOnly` all have to be
 * applied AFTERWARDS, in application code. Over-fetching 4x (the reference
 * implementation's factor) is what stops a tenant whose nearest neighbours are
 * mostly another tenant's rows from ending up with an empty dense channel.
 * It is a heuristic, not a guarantee: a big enough multi-tenant store can
 * still starve this channel, and the fix then is a per-tenant vec0 partition,
 * not a bigger multiplier.
 */
export const DENSE_OVERFETCH = 4;

export function denseChannel(
  driver: BetterSqliteDb,
  scope: ChannelScope,
  queryVector: readonly number[],
): string[] {
  const candidates = driver
    .prepare(
      `SELECT id, distance FROM ${VEC_TABLE}
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(vectorToBlob(queryVector), scope.limit * DENSE_OVERFETCH) as Array<{
    id: string;
    distance: number;
  }>;
  if (candidates.length === 0) return [];

  // One round-trip to find out which of the neighbours this caller may
  // actually see, then filter IN NEIGHBOUR ORDER — the set tells us what is
  // allowed, the original list keeps the ranking.
  const ids = candidates.map((c) => c.id);
  const filter = scopeFilter(scope, '');
  const allowed = new Set<string>();
  const CHUNK = 500;
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = driver
      .prepare(
        `SELECT id FROM ${TABLE} WHERE ${filter.sql} AND id IN (${placeholders})`,
      )
      .all(...filter.params, ...chunk) as Array<{ id: string }>;
    for (const row of rows) allowed.add(row.id);
  }
  return ids.filter((id) => allowed.has(id)).slice(0, scope.limit);
}

/**
 * Temporal channel — the tenant's most recent rows, QUERY-INDEPENDENT.
 *
 * It ADMITS candidates rather than merely reordering ones another channel
 * found, exactly as `MemoryRepository.temporal` does, and that is deliberate
 * and settled: a query matching nothing therefore returns recent rows rather
 * than an empty answer. The product instinct runs the other way ("memory has
 * nothing about that" beats fifteen unrelated facts as hallucination fuel),
 * but the accuracy gate rung 4 re-measures against was produced with the
 * admitting channel, and design §4.2 already routes exactly this risk to that
 * measurement rather than to an argument. See
 * `.claude/memory/decisions/2026-09-19-TASK-434.md`.
 *
 * The ordering key is `transaction_time DESC, valid_start DESC` — the
 * reference's, not this package's filtered-listing order. That is deliberate,
 * and the two are answering different questions: the listing answers "what is
 * true, newest first" (`valid_start DESC, id DESC`, pinned by a contract case),
 * while this channel answers "what did I learn most recently". Because the
 * channel ADMITS its rows rather than merely ranking ones some other channel
 * found, this ORDER BY decides their RRF ranks and so moves the fused answer.
 *
 * The keys agree on ~93% of rows — `when` equals the extraction date on that
 * share (design §4.1) — so the divergence is bounded. It is still worth being
 * faithful about, for the same reason the admitting behaviour above is: rung 4
 * has to replicate what rung 1 measured, and an unmeasured retrieval change
 * made by fiat at rung 2 would quietly make that number answer a different
 * question.
 *
 * `, id DESC` is appended beyond the reference: it is what makes a `LIMIT` over
 * rows tied on both clocks a deterministic SET and not merely a deterministic
 * order — the same argument that already put the tiebreak on the listing.
 */
export function temporalChannel(driver: BetterSqliteDb, scope: ChannelScope): string[] {
  const filter = scopeFilter(scope, '');
  const rows = driver
    .prepare(
      `SELECT id FROM ${TABLE}
        WHERE ${filter.sql}
        ORDER BY transaction_time DESC, valid_start DESC, id DESC
        LIMIT ?`,
    )
    .all(...filter.params, scope.limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Fetch the rows behind a ranked id list, IN THAT ORDER. The ranking is the
 * answer; SQLite's row order for an `IN (...)` is not, so the list drives the
 * output rather than the query plan. An id with no row (raced against a
 * `clear`) is dropped rather than yielding a hole.
 *
 * Tenant-scoped even though every id reaching it came out of an
 * already-tenant-scoped channel. That is defence in depth, not belt-and-braces
 * theatre: this is the LAST query before rows become the answer, it is the
 * only one in the fusion path whose `WHERE` would otherwise be a bare id list,
 * and a future channel that forgot its own scope would leak through it
 * silently. Invariant 5 — every hop.
 *
 * `ownerUserId` rides along for exactly that reason and no other. Every id
 * here already came out of an owner-filtered channel, so this predicate should
 * never remove a row — but "should never" is the whole argument for having it:
 * an unscoped hydration is a latent hole that opens the moment a channel is
 * added or a filter is edited, and it opens SILENTLY, since the rows still
 * come back and still look like an answer. It stays in SQL rather than
 * becoming a `.filter()` on the result for the same reason the channels'
 * does — the store decides what this caller may see, and nothing downstream
 * gets handed a row it then has to be trusted to drop.
 *
 * A trailing optional parameter rather than a scope object, to keep the
 * existing `(driver, agentKey, ids)` shape readable at its one call site.
 */
export function rowsInRankOrder<T extends { id: string }>(
  driver: BetterSqliteDb,
  agentKey: string,
  ids: readonly string[],
  ownerUserId?: string,
): T[] {
  if (ids.length === 0) return [];
  const scoped = ownerUserId !== undefined;
  const byId = new Map<string, T>();
  const CHUNK = 500;
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = driver
      .prepare(
        `SELECT * FROM ${TABLE}
          WHERE agent_key = ?${scoped ? ' AND owner_user_id = ?' : ''}
            AND id IN (${placeholders})`,
      )
      .all(agentKey, ...(scoped ? [ownerUserId] : []), ...chunk) as T[];
    for (const row of rows) byId.set(row.id, row);
  }
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}
