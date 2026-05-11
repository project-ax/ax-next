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
  score: number;
}

// ---------------------------------------------------------------------------
// upsert — INSERT … ON CONFLICT (doc_id) DO UPDATE SET … (I22)
// ---------------------------------------------------------------------------
// Postgres supports native UPSERT semantics, so no delete-then-insert
// transaction is needed. The generated `search_tsv` column is maintained
// automatically on every row write.

export async function upsert(
  db: Kysely<MemoryStrataIndexDatabase>,
  doc: UpsertInput,
): Promise<void> {
  await db
    .insertInto('memory_strata_index_v1_docs')
    .values({
      doc_id: doc.docId,
      category: doc.category,
      slug: doc.slug,
      summary: doc.summary,
      fact_type: doc.factType,
      body: doc.body,
      headers: doc.headers,
    })
    .onConflict((oc) =>
      oc.column('doc_id').doUpdateSet({
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
// search — plainto_tsquery + ts_rank, optional category filter
// ---------------------------------------------------------------------------
// plainto_tsquery is already safe: Postgres strips FTS operators internally,
// so no manual escaping is needed (unlike FTS5 in SQLite).
//
// Empty query short-circuits to [] BEFORE calling postgres — plainto_tsquery('')
// returns an empty tsquery that matches nothing, but skipping the call avoids
// an unnecessary roundtrip.
//
// Score: ts_rank returns float >= 0 where higher = better match. Contract
// orientation matches (higher = more relevant) so returned as-is.

export async function search(
  db: Kysely<MemoryStrataIndexDatabase>,
  query: string,
  topK: number,
  categoryFilter?: string,
): Promise<SearchResultRow[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  type RawRow = Pick<MemoryStrataIndexDocRow, 'doc_id' | 'category' | 'slug' | 'summary'> & {
    score: number;
  };

  let rows: RawRow[];

  if (categoryFilter !== undefined) {
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_rank(search_tsv, plainto_tsquery('english', ${trimmed})) AS score
      FROM memory_strata_index_v1_docs
      WHERE search_tsv @@ plainto_tsquery('english', ${trimmed})
        AND category = ${categoryFilter}
      ORDER BY score DESC
      LIMIT ${topK}
    `.execute(db);
    rows = result.rows;
  } else {
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_rank(search_tsv, plainto_tsquery('english', ${trimmed})) AS score
      FROM memory_strata_index_v1_docs
      WHERE search_tsv @@ plainto_tsquery('english', ${trimmed})
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
    score: Number(r.score),
  }));
}

// ---------------------------------------------------------------------------
// deleteOne
// ---------------------------------------------------------------------------

export async function deleteOne(
  db: Kysely<MemoryStrataIndexDatabase>,
  docId: string,
): Promise<void> {
  await db
    .deleteFrom('memory_strata_index_v1_docs')
    .where('doc_id', '=', docId)
    .execute();
}

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

export async function clearAll(db: Kysely<MemoryStrataIndexDatabase>): Promise<void> {
  await db.deleteFrom('memory_strata_index_v1_docs').execute();
}
