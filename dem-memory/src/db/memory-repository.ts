import type Database from "better-sqlite3";
import {
  INFINITY_SENTINEL,
  PROVENANCE_RANK,
  type EpistemicNetwork,
  type MemoryTuple,
  type Provenance,
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
  valid_start: string;
  valid_end: string;
  transaction_time: string;
  slot: string | null;
  provenance: Provenance | null;
  closed_by: string | null;
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
    validStart: row.valid_start,
    validEnd: row.valid_end,
    transactionTime: row.transaction_time,
    ...(row.slot ? { slot: row.slot } : {}),
    // A row written before the column existed reads NULL; it was an observer write, which is
    // what `extracted` means. Defaulting here rather than in SQL keeps the migration additive.
    provenance: row.provenance ?? "extracted",
    ...(row.closed_by ? { closedBy: row.closed_by } : {}),
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
  "id, bank_id, network, subject, predicate, object, source_chunk, valid_start, valid_end, " +
  "transaction_time, slot, provenance, closed_by";

/** What one slot settlement did, so the caller can report it without re-reading the row. */
export interface SlotClosure {
  /** Ids of previously-active rows this statement closed. */
  closed: string[];
  /** Set when the INCOMING row arrived already closed, by an active row dated later (rule 2). */
  selfClosedBy: string | null;
  /** The instant it was closed at - the bounding row's `validStart`. */
  selfClosedAt: string | null;
}

export class MemoryRepository {
  constructor(private readonly db: Database.Database) {}

  insertMemory(tuple: MemoryTuple, embedding: number[]): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories
             (id, bank_id, network, subject, predicate, object, source_chunk, valid_start, valid_end,
              transaction_time, slot, provenance, closed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tuple.id,
          tuple.bankId,
          tuple.network,
          tuple.subject,
          tuple.predicate,
          tuple.object,
          tuple.sourceChunk ?? null,
          tuple.validStart,
          tuple.validEnd,
          tuple.transactionTime,
          tuple.slot ?? null,
          tuple.provenance,
          tuple.closedBy ?? null,
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

  /**
   * Insert a statement and settle its slot in ONE transaction — §3.4 of the DEM-first design.
   *
   * The rules, and why each one exists (all four are pinned by
   * `tests/slot-supersession.test.ts`, and two of them cannot be exercised by the LongMemEval
   * corpus at all, which is why they are unit-tested rather than measured):
   *
   *  1. End every row of this `(bank, subject, slot)` whose validity interval is still open
   *     at the new row's `validStart` — `valid_start <= S < valid_end`. AT OR BEFORE on the
   *     left, so an equal `validStart` is settled by rule 4; and open-at-S rather than
   *     `valid_end = infinity`, so a row already bounded by a later successor still gets
   *     shortened when something lands inside it.
   *  2. TWO-SIDED. If a row is dated AFTER the new one, the new row is the backdated one, so
   *     it is closed at the earliest such instant rather than left active beside a fresher
   *     value. DEM's own SQL is `valid_start <= ?` only, and in real ingest order that
   *     one-directional rule leaves both rows active on 25.6% of its matched flags.
   *     DEVIATION FROM §3.4, deliberate: the design says "if an ACTIVE row", and active-only
   *     produces overlapping intervals on newest-first arrival. See the comment at `bound`.
   *  3. PROVENANCE IMMUNITY. A row is closed only by a row of equal-or-higher provenance, so
   *     a person's correction survives the next time the extractor reads the old value out of
   *     a transcript. This applies in BOTH directions: a lower-provenance row cannot close a
   *     higher one (rule 1) and is not bounded by one either (rule 2) — otherwise an extracted
   *     row would arrive dead on every turn after a human set the value.
   *  4. Equal `validStart`: the later transaction wins, i.e. the incoming row closes the
   *     resident one. Ties go to the newer assertion because that is what a correction is.
   *
   * A statement with no slot skips all of it: it is stored, retrievable, and inert. That is
   * most of the corpus and it is the safe direction — under-closing is the state the 87.4%
   * baseline was measured in.
   *
   * Returns what it did, because the caller reports it and the tests assert on it.
   */
  insertWithSlotClosure(tuple: MemoryTuple, embedding: number[]): SlotClosure {
    const settle = this.db.transaction((): SlotClosure => {
      this.insertMemory(tuple, embedding);
      // Everything below reads the row back out of the same transaction, so `tuple` and the
      // store cannot disagree about what was just written.

      if (tuple.slot === undefined) return { closed: [], selfClosedBy: null, selfClosedAt: null };

      const incomingRank = PROVENANCE_RANK[tuple.provenance];
      // Every OTHER row of this (subject, slot) that still asserts something.
      //
      // Note what is EXCLUDED: rows closed with `closed_by IS NULL`, which is an explicit
      // `forget`. A superseded row is still a true statement about a past interval and so
      // still bounds its neighbours; a retracted one asserts nothing and must not.
      // `id <> ?` because the row just inserted is itself active and cannot bound itself.
      const peers = this.db
        .prepare(
          `SELECT id, valid_start, valid_end, provenance
             FROM memories
            WHERE bank_id = ? AND subject = ? AND slot = ? AND id <> ?
              AND (valid_end = ? OR closed_by IS NOT NULL)`,
        )
        .all(tuple.bankId, tuple.subject, tuple.slot, tuple.id, INFINITY_SENTINEL) as Array<{
        id: string;
        valid_start: string;
        valid_end: string;
        provenance: Provenance | null;
      }>;

      // Rule 3, applied once and to both directions.
      const reachable = peers.filter(
        (peer) => PROVENANCE_RANK[peer.provenance ?? "extracted"] <= incomingRank,
      );

      // Rules 1 and 4: end every reachable row whose interval is still OPEN AT this
      // statement's start — `valid_start <= S < valid_end`.
      //
      // "Still open at S" rather than "active", because a row closed by a LATER successor can
      // still span S. Write Denver (Sep), then Boston (Jan) — Boston is bounded at Sep — then
      // Seattle (Jun): Seattle lands inside Boston's [Jan, Sep), and an active-only rule leaves
      // Boston claiming January through September beside Seattle's June through September.
      // Shortening the spanning row is what keeps the history a chain.
      //
      // In a well-formed chain exactly one row spans any instant, so this closes one row —
      // the measured maximum, against DEM's 622. It closes more than one only where
      // provenance immunity has deliberately left two lines of assertion open at once.
      const closed = reachable
        .filter(
          (peer) => peer.valid_start <= tuple.validStart && peer.valid_end > tuple.validStart,
        )
        .map((peer) => peer.id);
      if (closed.length > 0) {
        const close = this.db.prepare(
          `UPDATE memories SET valid_end = ?, closed_by = ? WHERE id = ?`,
        );
        for (const id of closed) close.run(tuple.validStart, tuple.id, id);
      }

      // Rule 2, bounded at the EARLIEST later row — ACTIVE OR NOT.
      //
      // §3.4 says "if an active R' has R'.when > S.when", and taking that literally produces
      // OVERLAPPING intervals whenever three values arrive newest-first. Write Denver (Sep),
      // then Seattle (Jun), then Boston (Jan): by the time Boston lands, Seattle has already
      // been bounded by Denver and is no longer active, so an active-only rule bounds Boston
      // at Sep — and a temporal query for July then returns Boston AND Seattle, both
      // asserting where one person lived. Considering superseded rows too keeps the
      // (subject, slot) history a chain: each row ends exactly where its successor begins.
      const bound = reachable
        .filter((peer) => peer.valid_start > tuple.validStart)
        .sort((a, b) => a.valid_start.localeCompare(b.valid_start))[0];
      if (bound !== undefined) {
        this.db
          .prepare(`UPDATE memories SET valid_end = ?, closed_by = ? WHERE id = ?`)
          .run(bound.valid_start, bound.id, tuple.id);
      }

      return {
        closed,
        selfClosedBy: bound?.id ?? null,
        selfClosedAt: bound?.valid_start ?? null,
      };
    });
    return settle();
  }

  /**
   * Explicit close — the UI's delete, and the only way a row ends without a successor.
   *
   * `closed_by` stays NULL, which is what distinguishes "superseded by that row" from
   * "somebody forgot this". Returns the ids it actually closed, so a caller handed a foreign
   * or already-closed id learns that rather than assuming.
   */
  supersede(bankId: string, ids: readonly string[], at: string): string[] {
    if (ids.length === 0) return [];
    const close = this.db.transaction((): string[] => {
      const done: string[] = [];
      const statement = this.db.prepare(
        `UPDATE memories SET valid_end = ? WHERE id = ? AND bank_id = ? AND valid_end = ?`,
      );
      for (const id of ids) {
        if (statement.run(at, id, bankId, INFINITY_SENTINEL).changes > 0) done.push(id);
      }
      return done;
    });
    return close();
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
