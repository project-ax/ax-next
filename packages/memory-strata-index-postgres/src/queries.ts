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
// buildOrTsQuery — OR-join query terms (mirrors sqlite's escapeFts5Query)
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
// without hand-rolling tsquery escaping. This mirrors sqlite's per-token OR
// join so the two backends stay genuinely interchangeable under the shared
// conformance kit (see Test 8b: a query term absent from a doc must not
// suppress a match on a different term present only in the body).
function buildOrTsQuery(trimmed: string): string {
  return trimmed.split(/\s+/).filter((t) => t.length > 0).join(' OR ');
}

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
  // docs (TASK-186).
  if (categoryFilter !== undefined) {
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_headline('english', body,
               websearch_to_tsquery('english', ${orQuery}),
               'MaxWords=48, MinWords=16, MaxFragments=1') AS snippet,
             ts_rank(search_tsv, websearch_to_tsquery('english', ${orQuery})) AS score
      FROM memory_strata_index_v2_docs
      WHERE search_tsv @@ websearch_to_tsquery('english', ${orQuery})
        AND agent_key = ${agentKey}
        AND category = ${categoryFilter}
      ORDER BY score DESC
      LIMIT ${topK}
    `.execute(db);
    rows = result.rows;
  } else {
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_headline('english', body,
               websearch_to_tsquery('english', ${orQuery}),
               'MaxWords=48, MinWords=16, MaxFragments=1') AS snippet,
             ts_rank(search_tsv, websearch_to_tsquery('english', ${orQuery})) AS score
      FROM memory_strata_index_v2_docs
      WHERE search_tsv @@ websearch_to_tsquery('english', ${orQuery})
        AND agent_key = ${agentKey}
      ORDER BY score DESC
      LIMIT ${topK}
    `.execute(db);
    rows = result.rows;
  }

  return rows.map((r) => ({
    docId: r.doc_id,
    category: r.category,
    slug: r.slug,
    summary: r.summary,
    // ts_headline emits <b>…</b> around matches by default; strip for clean
    // model-facing text (mirrors sqlite's empty-marker snippet()).
    snippet: String(r.snippet).replace(/<\/?b>/g, ''),
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
