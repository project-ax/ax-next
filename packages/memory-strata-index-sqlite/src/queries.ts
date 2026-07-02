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

export function upsert(rawDriver: BetterSqliteDb, agentKey: string, doc: UpsertInput): void {
  const txn = rawDriver.transaction(() => {
    // Scope the delete+insert by (agent_key, doc_id) so an upsert from agent A
    // never touches agent B's identically-keyed row (TASK-186).
    rawDriver
      .prepare(`DELETE FROM ${TABLE} WHERE agent_key = ? AND doc_id = ?`)
      .run(agentKey, doc.docId);
    rawDriver
      .prepare(
        `INSERT INTO ${TABLE} (agent_key, doc_id, category, slug, summary, fact_type, body, headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agentKey, doc.docId, doc.category, doc.slug, doc.summary, doc.factType, doc.body, doc.headers);
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
  snippet: string;
  score: number;
}

export async function search(
  db: Kysely<Database>,
  agentKey: string,
  query: string,
  topK: number,
  categoryFilter?: string,
): Promise<SearchResultRow[]> {
  const escaped = escapeFts5Query(query);
  if (escaped === '') return [];

  // Build query with optional category filter. Every variant filters by
  // `agent_key` so an agent only searches its OWN docs (TASK-186).
  // bm25() returns negative values (more-negative = better match).
  // We negate at the row-mapping step so the surfaced score has the same
  // contract orientation as the postgres backend (higher = better).
  let rawRows: Array<{
    doc_id: string;
    category: string;
    slug: string;
    summary: string;
    snippet: string;
    raw_score: number;
  }>;

  if (categoryFilter !== undefined) {
    const result = await sql<{
      doc_id: string;
      category: string;
      slug: string;
      summary: string;
      snippet: string;
      raw_score: number;
    }>`
      SELECT doc_id, category, slug, summary,
             snippet(${sql.raw(TABLE)}, 6, '', '', '…', 48) AS snippet,
             bm25(${sql.raw(TABLE)}) AS raw_score
      FROM ${sql.raw(TABLE)}
      WHERE ${sql.raw(TABLE)} MATCH ${escaped}
        AND agent_key = ${agentKey}
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
      snippet: string;
      raw_score: number;
    }>`
      SELECT doc_id, category, slug, summary,
             snippet(${sql.raw(TABLE)}, 6, '', '', '…', 48) AS snippet,
             bm25(${sql.raw(TABLE)}) AS raw_score
      FROM ${sql.raw(TABLE)}
      WHERE ${sql.raw(TABLE)} MATCH ${escaped}
        AND agent_key = ${agentKey}
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
    snippet: r.snippet,
    // bm25() returns negative values; more negative = better match.
    // Negate to get a positive score where higher = better match.
    score: -r.raw_score,
  }));
}

// ---------------------------------------------------------------------------
// deleteOne
// ---------------------------------------------------------------------------

export async function deleteOne(
  db: Kysely<Database>,
  agentKey: string,
  docId: string,
): Promise<void> {
  // Scoped to the caller's agent_key so deleting docId for A can't remove B's
  // identically-keyed row (TASK-186).
  await sql`DELETE FROM ${sql.raw(TABLE)} WHERE agent_key = ${agentKey} AND doc_id = ${docId}`.execute(db);
}

// ---------------------------------------------------------------------------
// clearAll — clears only the calling agent's docs (TASK-186), not the whole
// shared table.
// ---------------------------------------------------------------------------

export async function clearAll(db: Kysely<Database>, agentKey: string): Promise<void> {
  await sql`DELETE FROM ${sql.raw(TABLE)} WHERE agent_key = ${agentKey}`.execute(db);
}
