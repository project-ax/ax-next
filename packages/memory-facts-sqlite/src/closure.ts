import type { Database as BetterSqliteDb } from 'better-sqlite3';
import type { Provenance } from '@ax/memory-facts-contract';
import { TABLE, INFINITY_SENTINEL, type FactRow } from './schema.js';

/**
 * Provenance ranking — copied verbatim (small enough to duplicate rather
 * than share, per Invariant 2) from `dem-memory/src/types.ts`'s
 * `PROVENANCE_RANK`. A row is only ever closed by a row of equal-or-higher
 * provenance.
 */
export const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = {
  extracted: 0,
  agent: 1,
  human: 2,
};

export interface StatementToInsert {
  id: string;
  about: string;
  relation: string;
  value: string;
  when: string;
  slot?: string;
  provenance: Provenance;
  ownerUserId?: string;
  conversationId?: string;
  transactionTime: string;
}

/** What one slot settlement did, so the caller can report it without re-reading the row. */
export interface SlotClosure {
  /** Ids of previously-active (or previously rule-closed) rows this statement closed. */
  closed: string[];
  /** Set when the INCOMING row arrived already closed, by an active-or-closed row dated later (rule 2). */
  selfClosedBy: string | null;
  /** The instant it was closed at — the bounding row's `valid_start`. */
  selfClosedAt: string | null;
}

/**
 * Insert a statement and settle its slot in ONE transaction — ported from
 * `dem-memory/src/db/memory-repository.ts`'s `insertWithSlotClosure`
 * (§3.4 of the DEM-first design), scoped by `agent_key` instead of
 * `bank_id` and `about` instead of `subject`. Rules 1-4 are unchanged; see
 * that file's docstring for the full rationale. Slot DERIVATION is not this
 * engine's job — a statement arrives with `slot` already set, or absent.
 *
 * A statement with no slot skips all of it: stored, retrievable, and inert.
 */
export function insertWithSlotClosure(
  driver: BetterSqliteDb,
  agentKey: string,
  statement: StatementToInsert,
): SlotClosure {
  const settle = driver.transaction((): SlotClosure => {
    driver
      .prepare(
        `INSERT INTO ${TABLE}
           (id, agent_key, about, relation, value, slot, provenance, owner_user_id,
            conversation_id, valid_start, valid_end, transaction_time, closed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        statement.id,
        agentKey,
        statement.about,
        statement.relation,
        statement.value,
        statement.slot ?? null,
        statement.provenance,
        statement.ownerUserId ?? null,
        statement.conversationId ?? null,
        statement.when,
        INFINITY_SENTINEL,
        statement.transactionTime,
        null,
      );

    if (statement.slot === undefined) {
      return { closed: [], selfClosedBy: null, selfClosedAt: null };
    }

    const incomingRank = PROVENANCE_RANK[statement.provenance];

    // Every OTHER row of this (agent, about, slot) that still asserts
    // something. Excludes rows closed with `closed_by IS NULL` — an
    // explicit `supersede` — because a retracted row asserts nothing and
    // must not bound its neighbours, whereas a rule-superseded row is still
    // a true statement about a past interval and does.
    const peers = driver
      .prepare(
        `SELECT id, valid_start, valid_end, provenance
           FROM ${TABLE}
          WHERE agent_key = ? AND about = ? AND slot = ? AND id <> ?
            AND (valid_end = ? OR closed_by IS NOT NULL)`,
      )
      .all(agentKey, statement.about, statement.slot, statement.id, INFINITY_SENTINEL) as Array<{
      id: string;
      valid_start: string;
      valid_end: string;
      provenance: FactRow['provenance'] | null;
    }>;

    // Rule 3, applied once and to both directions.
    const reachable = peers.filter(
      (peer) => PROVENANCE_RANK[peer.provenance ?? 'extracted'] <= incomingRank,
    );

    // Rules 1 and 4: end every reachable row whose interval is still OPEN
    // AT this statement's start — `valid_start <= S < valid_end`.
    const closed = reachable
      .filter((peer) => peer.valid_start <= statement.when && peer.valid_end > statement.when)
      .map((peer) => peer.id);
    if (closed.length > 0) {
      const close = driver.prepare(`UPDATE ${TABLE} SET valid_end = ?, closed_by = ? WHERE id = ?`);
      for (const id of closed) close.run(statement.when, statement.id, id);
    }

    // Rule 2, bounded at the EARLIEST later row — ACTIVE OR NOT.
    const bound = reachable
      .filter((peer) => peer.valid_start > statement.when)
      .sort((a, b) => a.valid_start.localeCompare(b.valid_start))[0];
    if (bound !== undefined) {
      driver
        .prepare(`UPDATE ${TABLE} SET valid_end = ?, closed_by = ? WHERE id = ?`)
        .run(bound.valid_start, bound.id, statement.id);
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
 * Explicit close — the only way a row ends without a successor. `closed_by`
 * stays NULL, which is what distinguishes "superseded by that row" from
 * "somebody retracted this". Returns the ids it actually closed, so a caller
 * handed a foreign or already-closed id learns that rather than assuming.
 */
export function supersedeIds(
  driver: BetterSqliteDb,
  agentKey: string,
  ids: readonly string[],
  at: string,
): string[] {
  if (ids.length === 0) return [];
  const close = driver.transaction((): string[] => {
    const done: string[] = [];
    const statement = driver.prepare(
      `UPDATE ${TABLE} SET valid_end = ? WHERE id = ? AND agent_key = ? AND valid_end = ?`,
    );
    for (const id of ids) {
      if (statement.run(at, id, agentKey, INFINITY_SENTINEL).changes > 0) done.push(id);
    }
    return done;
  });
  return close();
}
