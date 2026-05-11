import { sql, type Kysely } from 'kysely';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import type { Database } from './schema.js';
import { TABLE } from './schema.js';
import type { UpsertInput } from '@ax/memory-strata-index-contract';

// ---------------------------------------------------------------------------
// FTS5 query escaping (CRITICAL — I17)
// ---------------------------------------------------------------------------
// FTS5 has its own query language (AND, OR, NEAR, etc.). To search for
// the user's terms without triggering boolean/syntax parsing, we split by
// whitespace and wrap each token in double quotes. FTS5 double-quoted tokens
// are treated as literal single-token phrase queries — operators like AND, OR,
// NEAR are neutralised. Internal double-quote characters are doubled per FTS5
// spec. Tokens are joined with " OR " so a document matching ANY of the query
// terms is returned — this is the expected full-text search behaviour (BM25
// ranking surfaces better-matching docs first).
//
// Examples:
//   "react AND vue"      →  `"react" OR "AND" OR "vue"`
//   `he said "hi"`       →  `"he" OR "said" OR """hi"""`  (each token quoted)
//   "TypeScript language" →  `"TypeScript" OR "language"`
//   ""                   →  ''  (empty string — no results, no crash)

export function escapeFts5Query(q: string): string {
  const tokens = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  // Wrap each token in double-quotes, doubling any internal double-quote chars.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// ---------------------------------------------------------------------------
// upsert — transactional delete + insert (I22)
// ---------------------------------------------------------------------------
// FTS5 has no native UPSERT semantics. We use a transaction so that a crash
// between the DELETE and INSERT never leaves the index empty for this docId —
// on failure, the transaction rolls back and the prior version is intact.
// We use the raw better-sqlite3 driver's synchronous transaction() helper
// since better-sqlite3 is inherently synchronous and Kysely wraps it with
// promises.

export function upsert(rawDriver: BetterSqliteDb, doc: UpsertInput): void {
  const txn = rawDriver.transaction(() => {
    rawDriver
      .prepare(`DELETE FROM ${TABLE} WHERE doc_id = ?`)
      .run(doc.docId);
    rawDriver
      .prepare(
        `INSERT INTO ${TABLE} (doc_id, category, slug, summary, fact_type, body, headers)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.docId, doc.category, doc.slug, doc.summary, doc.factType, doc.body, doc.headers);
  });
  txn();
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchResultRow {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  score: number;
}

export async function search(
  db: Kysely<Database>,
  query: string,
  topK: number,
  categoryFilter?: string,
): Promise<SearchResultRow[]> {
  const escaped = escapeFts5Query(query);
  if (escaped === '') return [];

  // Build query with optional category filter.
  // bm25() returns negative values (more-negative = better match).
  // We negate at the row-mapping step so the surfaced score has the same
  // contract orientation as the postgres backend (higher = better).
  let rawRows: Array<{
    doc_id: string;
    category: string;
    slug: string;
    summary: string;
    raw_score: number;
  }>;

  if (categoryFilter !== undefined) {
    const result = await sql<{
      doc_id: string;
      category: string;
      slug: string;
      summary: string;
      raw_score: number;
    }>`
      SELECT doc_id, category, slug, summary, bm25(${sql.raw(TABLE)}) AS raw_score
      FROM ${sql.raw(TABLE)}
      WHERE ${sql.raw(TABLE)} MATCH ${escaped}
        AND category = ${categoryFilter}
      ORDER BY bm25(${sql.raw(TABLE)}) ASC
      LIMIT ${topK}
    `.execute(db);
    rawRows = result.rows;
  } else {
    const result = await sql<{
      doc_id: string;
      category: string;
      slug: string;
      summary: string;
      raw_score: number;
    }>`
      SELECT doc_id, category, slug, summary, bm25(${sql.raw(TABLE)}) AS raw_score
      FROM ${sql.raw(TABLE)}
      WHERE ${sql.raw(TABLE)} MATCH ${escaped}
      ORDER BY bm25(${sql.raw(TABLE)}) ASC
      LIMIT ${topK}
    `.execute(db);
    rawRows = result.rows;
  }

  return rawRows.map((r) => ({
    docId: r.doc_id,
    category: r.category,
    slug: r.slug,
    summary: r.summary,
    // bm25() returns negative values; more negative = better match.
    // Negate to get a positive score where higher = better match.
    score: -r.raw_score,
  }));
}

// ---------------------------------------------------------------------------
// deleteOne
// ---------------------------------------------------------------------------

export async function deleteOne(db: Kysely<Database>, docId: string): Promise<void> {
  await sql`DELETE FROM ${sql.raw(TABLE)} WHERE doc_id = ${docId}`.execute(db);
}

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

export async function clearAll(db: Kysely<Database>): Promise<void> {
  await sql`DELETE FROM ${sql.raw(TABLE)}`.execute(db);
}
