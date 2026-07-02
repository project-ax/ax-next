import { sql, type Kysely } from 'kysely';
import type { MemoryStrataIndexDatabase, MemoryStrataIndexDocRow } from './migrations.js';
import type { UpsertInput } from '@ax/memory-strata-index-contract';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SearchResultRow {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}

// ---------------------------------------------------------------------------
// upsert — INSERT … ON CONFLICT (agent_key, doc_id) DO UPDATE SET … (I22)
// ---------------------------------------------------------------------------
// Postgres supports native UPSERT semantics, so no delete-then-insert
// transaction is needed. The generated `search_tsv` column is maintained
// automatically on every row write.
//
// The conflict target is the composite PRIMARY KEY (agent_key, doc_id), so two
// agents can hold the same docId without clobbering each other (TASK-186).

export async function upsert(
  db: Kysely<MemoryStrataIndexDatabase>,
  agentKey: string,
  doc: UpsertInput,
): Promise<void> {
  await db
    .insertInto('memory_strata_index_v2_docs')
    .values({
      agent_key: agentKey,
      doc_id: doc.docId,
      category: doc.category,
      slug: doc.slug,
      summary: doc.summary,
      fact_type: doc.factType,
      body: doc.body,
      headers: doc.headers,
    })
    .onConflict((oc) =>
      oc.columns(['agent_key', 'doc_id']).doUpdateSet({
        category: doc.category,
        slug: doc.slug,
        summary: doc.summary,
        fact_type: doc.factType,
        body: doc.body,
        headers: doc.headers,
      }),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// buildOrTsQuery — quote + OR-join query terms (mirrors sqlite's
// escapeFts5Query)
// ---------------------------------------------------------------------------
// plainto_tsquery ANDs every term together. A multi-word memory_search query
// (e.g. "degree graduated") is meant as "find docs about ANY of these terms",
// not a strict boolean AND — the consolidator's coarse per-category mega-docs
// mean a query term is often present in the body while a different query term
// is absent everywhere in that doc, and a strict AND then returns zero rows
// even though the doc plainly answers the question (the false-refusal bug
// this feature exists to fix). websearch_to_tsquery is Postgres's own
// hardened function for parsing raw user input (like plainto_tsquery, it
// never throws on malformed syntax) and additionally understands an explicit
// `OR` keyword, so joining tokens with a literal ' OR ' gives OR semantics
// without hand-rolling tsquery escaping.
//
// Each token is double-quoted so websearch_to_tsquery's OTHER operators are
// neutralized too — exactly as escapeFts5Query quotes tokens to neutralize
// FTS5's. Unquoted, a `-`-prefixed token becomes NOT and INVERTS matching
// ("foo -bar" → 'foo' | !'bar' matches every doc LACKING bar — arbitrary
// topK noise; contract Test 8c). Inside quotes, `-` and `OR` are literal
// text. Embedded double quotes are replaced with a space (they would close
// the quote early); the residue parses as an adjacent-phrase, still
// operator-free. This keeps the two backends genuinely interchangeable under
// the shared conformance kit.
export function buildOrTsQuery(trimmed: string): string {
  return trimmed
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, ' ')}"`)
    .join(' OR ');
}

// ---------------------------------------------------------------------------
// ts_headline snippet options
// ---------------------------------------------------------------------------
// The snippet is a bounded, match-centered excerpt of the body so the agent
// sees the answer value in the search result itself (design
// docs/plans/2026-07-01-memory-search-snippet-design.md). Options, and why:
//
//   StartSel="", StopSel=""  — empty highlight markers, so no <b>…</b> wraps
//     the matched terms and the text is clean for the model. The markers MUST
//     be double-QUOTED: the design doc's literal `StartSel=, StopSel=` (empty
//     value, no quotes, trailing the list) raises `ERROR: invalid parameter
//     list format` on postgres 16, and a bare `StartSel=` swallows the next
//     comma as its value (a `,term,` artifact). Verified against the real
//     testcontainer. Because the markers are empty, NO mapper-side regex strip
//     is needed (that's why the old `.replace(/<\/?b>/g, '')` is gone).
//
//   FragmentDelimiter=…, MaxFragments=2  — truncation-marker parity with the
//     sqlite backend, whose snippet() carries '…'. ts_headline only emits the
//     delimiter BETWEEN fragments, so we allow up to 2 fragments: a single
//     match region stays one ~48-word window (no '…', identical to before),
//     while scattered matches in a long mega-doc are joined by '…' signalling
//     elided content. (Residual divergence from sqlite: ts_headline emits no
//     leading/trailing boundary '…' — it can't mark a single window as cut
//     from a larger body the way sqlite does.)
//
//   MaxWords=48, MinWords=16  — ~48-token window, compact for coarse per-
//     category mega-docs while still capturing the query-adjacent value.
//
// NOTE: a literal `<b>` occurring in the body does NOT survive into a postgres
// snippet — the default text-search parser classifies `<...>` as a `tag` token
// and ts_headline drops it from windowed output (only HighlightAll=true, which
// returns the whole body, preserves tags). This is a documented backend
// divergence from sqlite, which returns the raw body text verbatim.
const SNIPPET_OPTIONS =
  'MaxWords=48, MinWords=16, MaxFragments=2, FragmentDelimiter=…, StartSel="", StopSel=""';

// ---------------------------------------------------------------------------
// search — websearch_to_tsquery (OR-joined) + ts_rank, optional category filter
// ---------------------------------------------------------------------------
// Empty query short-circuits to [] BEFORE calling postgres — an empty tsquery
// matches nothing, but skipping the call avoids an unnecessary roundtrip.
//
// Score: ts_rank returns float >= 0 where higher = better match. Contract
// orientation matches (higher = more relevant) so returned as-is.

export async function search(
  db: Kysely<MemoryStrataIndexDatabase>,
  agentKey: string,
  query: string,
  topK: number,
  categoryFilter?: string,
): Promise<SearchResultRow[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const orQuery = buildOrTsQuery(trimmed);

  type RawRow = Pick<MemoryStrataIndexDocRow, 'doc_id' | 'category' | 'slug' | 'summary'> & {
    snippet: string;
    score: number;
  };

  let rows: RawRow[];

  // Every variant filters by `agent_key` so an agent only searches its own
  // docs (TASK-186). ts_headline is computed in the OUTER select over the
  // ORDER BY / LIMIT'd subquery, so the whole-body headline parse runs only on
  // the returned topK rows — not on every WHERE match (ts_rank + the predicate
  // stay in the inner query where they belong).
  if (categoryFilter !== undefined) {
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_headline('english', body,
               websearch_to_tsquery('english', ${orQuery}),
               ${SNIPPET_OPTIONS}) AS snippet,
             score
      FROM (
        SELECT doc_id, category, slug, summary, body,
               ts_rank(search_tsv, websearch_to_tsquery('english', ${orQuery})) AS score
        FROM memory_strata_index_v2_docs
        WHERE search_tsv @@ websearch_to_tsquery('english', ${orQuery})
          AND agent_key = ${agentKey}
          AND category = ${categoryFilter}
        ORDER BY score DESC
        LIMIT ${topK}
      ) AS top
      ORDER BY score DESC
    `.execute(db);
    rows = result.rows;
  } else {
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_headline('english', body,
               websearch_to_tsquery('english', ${orQuery}),
               ${SNIPPET_OPTIONS}) AS snippet,
             score
      FROM (
        SELECT doc_id, category, slug, summary, body,
               ts_rank(search_tsv, websearch_to_tsquery('english', ${orQuery})) AS score
        FROM memory_strata_index_v2_docs
        WHERE search_tsv @@ websearch_to_tsquery('english', ${orQuery})
          AND agent_key = ${agentKey}
        ORDER BY score DESC
        LIMIT ${topK}
      ) AS top
      ORDER BY score DESC
    `.execute(db);
    rows = result.rows;
  }

  return rows.map((r) => ({
    docId: r.doc_id,
    category: r.category,
    slug: r.slug,
    summary: r.summary,
    // Empty StartSel/StopSel mean ts_headline emits no highlight markers, so
    // the snippet is already clean model-facing text — no strip needed.
    snippet: r.snippet,
    score: Number(r.score),
  }));
}

// ---------------------------------------------------------------------------
// deleteOne
// ---------------------------------------------------------------------------

export async function deleteOne(
  db: Kysely<MemoryStrataIndexDatabase>,
  agentKey: string,
  docId: string,
): Promise<void> {
  // Scoped to (agent_key, doc_id) so deleting docId for A can't remove B's
  // identically-keyed row (TASK-186).
  await db
    .deleteFrom('memory_strata_index_v2_docs')
    .where('agent_key', '=', agentKey)
    .where('doc_id', '=', docId)
    .execute();
}

// ---------------------------------------------------------------------------
// clearAll — clears only the calling agent's docs (TASK-186), not the whole
// shared table.
// ---------------------------------------------------------------------------

export async function clearAll(
  db: Kysely<MemoryStrataIndexDatabase>,
  agentKey: string,
): Promise<void> {
  await db
    .deleteFrom('memory_strata_index_v2_docs')
    .where('agent_key', '=', agentKey)
    .execute();
}
