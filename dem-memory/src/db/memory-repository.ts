import type Database from "better-sqlite3";
import {
  INFINITY_SENTINEL,
  type EpistemicNetwork,
  type MemoryTuple,
} from "../types.js";

export const EMBEDDING_DIMENSIONS = 384;

export function vectorToBlob(vector: number[]): Buffer {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}`,
    );
  }
  return Buffer.from(new Float32Array(vector).buffer);
}

interface MemoryRow {
  id: string;
  bank_id: string;
  network: EpistemicNetwork;
  subject: string;
  predicate: string;
  object: string;
  source_chunk: string | null;
  confidence: number;
  valid_start: string;
  valid_end: string;
  transaction_time: string;
}

function rowToTuple(row: MemoryRow): MemoryTuple {
  return {
    id: row.id,
    bankId: row.bank_id,
    network: row.network,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    ...(row.source_chunk ? { sourceChunk: row.source_chunk } : {}),
    confidence: row.confidence,
    validStart: row.valid_start,
    validEnd: row.valid_end,
    transactionTime: row.transaction_time,
  };
}

export interface ValidityClause {
  sql: string;
  params: unknown[];
}

export function validityClause(temporalAnchor?: string): ValidityClause {
  if (temporalAnchor !== undefined) {
    return {
      sql: "valid_start <= ? AND ? < valid_end",
      params: [temporalAnchor, temporalAnchor],
    };
  }
  return { sql: "valid_end = ?", params: [INFINITY_SENTINEL] };
}

export function buildFtsMatchQuery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const cleaned = [
    ...new Set(tokens.map((token) => token.replace(/"/g, "")).filter(Boolean)),
  ].slice(0, 24);
  if (cleaned.length === 0) return null;
  return cleaned.map((token) => `"${token}"`).join(" OR ");
}

const SELECT_COLUMNS =
  "id, bank_id, network, subject, predicate, object, source_chunk, confidence, valid_start, valid_end, transaction_time";

export class MemoryRepository {
  constructor(private readonly db: Database.Database) {}

  insertMemory(tuple: MemoryTuple, embedding: number[]): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories
             (id, bank_id, network, subject, predicate, object, source_chunk, confidence, valid_start, valid_end, transaction_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tuple.id,
          tuple.bankId,
          tuple.network,
          tuple.subject,
          tuple.predicate,
          tuple.object,
          tuple.sourceChunk ?? null,
          tuple.confidence,
          tuple.validStart,
          tuple.validEnd,
          tuple.transactionTime,
        );
      this.db
        .prepare(`INSERT INTO memories_fts (id, subject, predicate, object) VALUES (?, ?, ?, ?)`)
        .run(tuple.id, tuple.subject, tuple.predicate, tuple.object);
      this.db
        .prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`)
        .run(tuple.id, vectorToBlob(embedding));
    });
    insert();
  }

  invalidateMemory(
    bankId: string,
    subject: string,
    predicate: string,
    validStart: string,
  ): number {
    return this.db
      .prepare(
        `UPDATE memories
         SET valid_end = ?
         WHERE bank_id = ?
           AND subject = ?
           AND predicate = ?
           AND valid_end = ?
           AND valid_start <= ?`,
      )
      .run(validStart, bankId, subject, predicate, INFINITY_SENTINEL, validStart).changes;
  }

  getByIds(ids: string[]): MemoryTuple[] {
    if (ids.length === 0) return [];
    const byId = new Map<string, MemoryTuple>();
    const chunkSize = 500;
    for (let start = 0; start < ids.length; start += chunkSize) {
      const chunk = ids.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders})`)
        .all(...chunk) as unknown as MemoryRow[];
      for (const row of rows) byId.set(row.id, rowToTuple(row));
    }
    return ids.flatMap((id) => {
      const tuple = byId.get(id);
      return tuple ? [tuple] : [];
    });
  }

  searchFts(
    bankId: string,
    match: string,
    temporalAnchor: string | undefined,
    limit: number,
  ): string[] {
    const validity = validityClause(temporalAnchor);
    const rows = this.db
      .prepare(
        `SELECT m.id AS id
         FROM memories_fts f JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ? AND m.bank_id = ? AND m.${validity.sql}
         ORDER BY bm25(memories_fts)
         LIMIT ?`,
      )
      .all(match, bankId, ...validity.params, limit) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  searchVec(
    bankId: string,
    queryVector: number[],
    knn: number,
    temporalAnchor: string | undefined,
    limit: number,
  ): string[] {
    const candidates = this.db
      .prepare(
        `SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      )
      .all(vectorToBlob(queryVector), knn) as unknown as Array<{ id: string; distance: number }>;
    if (candidates.length === 0) return [];

    const validity = validityClause(temporalAnchor);
    const distanceById = new Map<string, number>();
    for (const candidate of candidates) distanceById.set(candidate.id, candidate.distance);

    const ids = candidates.map((candidate) => candidate.id);
    const chunkSize = 500;
    const matched = new Set<string>();
    for (let start = 0; start < ids.length; start += chunkSize) {
      const chunk = ids.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT id FROM memories WHERE bank_id = ? AND ${validity.sql} AND id IN (${placeholders})`,
        )
        .all(bankId, ...validity.params, ...chunk) as unknown as Array<{ id: string }>;
      for (const row of rows) matched.add(row.id);
    }

    return ids.filter((id) => matched.has(id)).slice(0, limit);
  }

  memoriesBySubjects(
    bankId: string,
    subjects: string[],
    temporalAnchor: string | undefined,
    limit: number,
  ): MemoryTuple[] {
    if (subjects.length === 0) return [];
    const validity = validityClause(temporalAnchor);
    const chunkSize = 500;
    const rows: MemoryTuple[] = [];
    for (let start = 0; start < subjects.length; start += chunkSize) {
      const chunk = subjects.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const batch = this.db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM memories
           WHERE bank_id = ? AND subject IN (${placeholders}) AND ${validity.sql}
           LIMIT ?`,
        )
        .all(bankId, ...chunk, ...validity.params, limit) as unknown as MemoryRow[];
      rows.push(...batch.map(rowToTuple));
    }
    return rows;
  }

  temporal(bankId: string, temporalAnchor: string | undefined, limit: number): MemoryTuple[] {
    if (temporalAnchor !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM memories
           WHERE bank_id = ? AND valid_start <= ? AND ? < valid_end
           ORDER BY valid_start DESC, transaction_time DESC
           LIMIT ?`,
        )
        .all(bankId, temporalAnchor, temporalAnchor, limit) as unknown as MemoryRow[];
      return rows.map(rowToTuple);
    }
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM memories
         WHERE bank_id = ? AND valid_end = ?
         ORDER BY transaction_time DESC, valid_start DESC
         LIMIT ?`,
      )
      .all(bankId, INFINITY_SENTINEL, limit) as unknown as MemoryRow[];
    return rows.map(rowToTuple);
  }

  batches(bankId: string): string[][] {
    const rows = this.db
      .prepare(
        `SELECT subject, transaction_time FROM memories WHERE bank_id = ? ORDER BY rowid`,
      )
      .all(bankId) as unknown as Array<{ subject: string; transaction_time: string }>;
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const group = groups.get(row.transaction_time);
      if (group) group.push(row.subject);
      else groups.set(row.transaction_time, [row.subject]);
    }
    return [...groups.values()];
  }

  counts(bankId: string): { total: number; active: number; byNetwork: Record<EpistemicNetwork, number> } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE bank_id = ?`).get(bankId) as
        | { n: number }
        | undefined
    )?.n;
    const active = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM memories WHERE bank_id = ? AND valid_end = ?`)
        .get(bankId, INFINITY_SENTINEL) as { n: number } | undefined
    )?.n;
    const byNetwork: Record<EpistemicNetwork, number> = {
      world: 0,
      experience: 0,
      observation: 0,
      opinion: 0,
    };
    const rows = this.db
      .prepare(`SELECT network, COUNT(*) AS n FROM memories WHERE bank_id = ? GROUP BY network`)
      .all(bankId) as unknown as Array<{ network: EpistemicNetwork; n: number }>;
    for (const row of rows) byNetwork[row.network] = row.n;
    return { total: total ?? 0, active: active ?? 0, byNetwork };
  }
}
