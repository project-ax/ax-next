import type { Database as BetterSqliteDb } from 'better-sqlite3';
import type { FactKind, Provenance } from '@ax/memory-facts-contract';
import { TABLE, INFINITY_SENTINEL } from './schema.js';
import { PENDING_SLOT } from './pending.js';

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
  kind?: FactKind;
  transactionTime: string;
  /** The batch's idempotency key, or absent when the caller passed none. */
  batchKey?: string;
  /** 0-based position within the batch — the only stable ordering (see `FactRow.batch_seq`). */
  batchSeq: number;
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

// ---------------------------------------------------------------------------
// Rules 1-4, in one place
// ---------------------------------------------------------------------------

/** The only columns rules 1-4 read off a peer row. */
export interface ClosurePeer {
  id: string;
  valid_start: string;
  valid_end: string;
  provenance: Provenance;
}

/** The arriving statement, as the rules see it. */
export interface ClosureArrival {
  id: string;
  when: string;
  provenance: Provenance;
}

export interface ArrivalOutcome<P> {
  /** Peers this arrival closes (rule 1). Each ends at `arrival.when`, `closed_by = arrival.id`. */
  closed: P[];
  /** The earliest later peer that bounds this arrival (rule 2), or null. */
  bound: P | null;
}

/**
 * §3.4's rules 1-4 for ONE arrival against the peers that already exist in
 * its `(agent, about, slot)` chain. Pure — it decides, it does not write.
 *
 * It is generic over the peer type so both callers can use the SAME rules
 * (Invariant 4, one source of truth) without either distorting for the other:
 * `insertWithSlotClosure` hands it rows read out of SQLite and turns the
 * result into UPDATEs, while `resettleSlotGroups` hands it mutable in-memory
 * state objects and mutates the very objects it gets back. Returning the peer
 * OBJECTS rather than their ids is what makes the second caller lookup-free.
 *
 * Rule 3 (provenance immunity) is applied ONCE, to both directions: the
 * arrival interacts only with peers of equal-or-lower rank, so a human row
 * neither gets closed by an extracted one (rule 1) nor bounds it (rule 2).
 *
 * The rule-2 tiebreak is `(valid_start, id)`. Two peers can share the earliest
 * later `valid_start`; either gives the arrival the same `valid_end`, but they
 * give different `closed_by`, and SQLite promises no row order without an
 * ORDER BY. Sorting on `id` after `valid_start` makes the answer the same
 * every time — which is what lets `resettleSlotGroups` promise that re-running
 * it changes nothing.
 */
export function settleArrival<P extends ClosurePeer>(
  arrival: ClosureArrival,
  peers: readonly P[],
): ArrivalOutcome<P> {
  const incomingRank = PROVENANCE_RANK[arrival.provenance];

  // Rule 3, applied once and to both directions.
  const reachable = peers.filter(
    (peer) => peer.id !== arrival.id && PROVENANCE_RANK[peer.provenance] <= incomingRank,
  );

  // Rules 1 and 4: end every reachable row whose interval is still OPEN
  // AT this statement's start — `valid_start <= S < valid_end`. Rule 4 falls
  // out of the `<=`: an equal-`when` peer that arrived earlier is still open
  // at S, so the later write wins.
  const closed = reachable.filter(
    (peer) => peer.valid_start <= arrival.when && peer.valid_end > arrival.when,
  );

  // Rule 2, bounded at the EARLIEST later row — ACTIVE OR NOT.
  const bound =
    reachable
      .filter((peer) => peer.valid_start > arrival.when)
      .sort((a, b) => a.valid_start.localeCompare(b.valid_start) || a.id.localeCompare(b.id))[0] ??
    null;

  return { closed, bound };
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
 * So does a statement whose slot is {@link PENDING_SLOT} — see the early-out.
 *
 * The `driver.transaction(...)` here stays even though `record` now wraps the
 * WHOLE batch in an outer transaction: better-sqlite3 implements a nested
 * transaction function as a SAVEPOINT, so this one degrades to a savepoint
 * inside the batch's transaction and the batch still commits or rolls back as
 * one unit. Keeping it means a caller that settles a single statement outside
 * a batch (a future one — `record` is the only caller today) is still atomic
 * by itself, rather than silently depending on someone else's transaction.
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
            conversation_id, kind, valid_start, valid_end, transaction_time, closed_by,
            batch_key, batch_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        statement.kind ?? null,
        statement.when,
        INFINITY_SENTINEL,
        statement.transactionTime,
        null,
        statement.batchKey ?? null,
        statement.batchSeq,
      );

    // No slot, or a slot that is still PENDING: stored, retrievable, inert.
    //
    // Pending takes the no-slot path deliberately. The alternative — letting
    // `pending` behave like any other slot string — would build a bogus
    // `(about, 'pending')` chain in which every unrelated undrained fact about
    // the same subject closes the one before it: a `lives_in` guess would end
    // a `works_at` guess purely because neither had been normalized yet. That
    // is MIS-closing, and the whole point of §3.5's pending is the opposite —
    // "pending slot = under-closing, the safe direction". Nothing is lost:
    // `memory:facts:reindex` re-derives the chain once the real slot arrives.
    if (statement.slot === undefined || statement.slot === PENDING_SLOT) {
      return { closed: [], selfClosedBy: null, selfClosedAt: null };
    }

    // Every OTHER row of this (agent, about, slot) that still asserts
    // something. Excludes rows closed with `closed_by IS NULL` — an
    // explicit `supersede` — because a retracted row asserts nothing and
    // must not bound its neighbours, whereas a rule-superseded row is still
    // a true statement about a past interval and does.
    //
    // `slot <> PENDING_SLOT` is redundant while the early-out above stands
    // (a non-pending `slot = ?` can only match non-pending rows) and is kept
    // anyway, so "a pending row is never anybody's peer" is enforced by the
    // query that would violate it rather than by a guard fifteen lines away.
    const peers = driver
      .prepare(
        `SELECT id, valid_start, valid_end, provenance
           FROM ${TABLE}
          WHERE agent_key = ? AND about = ? AND slot = ? AND slot <> ? AND id <> ?
            AND (valid_end = ? OR closed_by IS NOT NULL)`,
      )
      .all(
        agentKey,
        statement.about,
        statement.slot,
        PENDING_SLOT,
        statement.id,
        INFINITY_SENTINEL,
      ) as Array<{
      id: string;
      valid_start: string;
      valid_end: string;
      provenance: Provenance | null;
    }>;

    const outcome = settleArrival(
      { id: statement.id, when: statement.when, provenance: statement.provenance },
      // The column is NOT NULL with a CHECK, so the coalesce is belt-and-
      // braces for a row written by some older schema; `extracted` is the
      // least-privileged guess, which is the safe way to be wrong here.
      peers.map((peer) => ({ ...peer, provenance: peer.provenance ?? 'extracted' })),
    );

    const closed = outcome.closed.map((peer) => peer.id);
    if (closed.length > 0) {
      const close = driver.prepare(`UPDATE ${TABLE} SET valid_end = ?, closed_by = ? WHERE id = ?`);
      for (const id of closed) close.run(statement.when, statement.id, id);
    }

    if (outcome.bound !== null) {
      driver
        .prepare(`UPDATE ${TABLE} SET valid_end = ?, closed_by = ? WHERE id = ?`)
        .run(outcome.bound.valid_start, outcome.bound.id, statement.id);
    }

    return {
      closed,
      selfClosedBy: outcome.bound?.id ?? null,
      selfClosedAt: outcome.bound?.valid_start ?? null,
    };
  });
  return settle();
}

// ---------------------------------------------------------------------------
// Re-settling a chain after `memory:facts:reindex` resolves a pending slot
// ---------------------------------------------------------------------------

/** One `(about, slot)` chain to re-derive. `slot` is a real slot, never {@link PENDING_SLOT}. */
export interface SlotGroup {
  about: string;
  slot: string;
}

/** Only what the replay reads. `provenance` is nullable for the same reason as above. */
interface GroupRow {
  id: string;
  valid_start: string;
  valid_end: string;
  provenance: Provenance | null;
  closed_by: string | null;
}

/** A row's closure state during the replay — the two columns the rules decide. */
interface ReplayState extends ClosurePeer {
  closed_by: string | null;
}

/**
 * Re-derive §3.4 over whole `(about, slot)` chains and write back only what
 * actually moved. Returns the ids whose `valid_end` or `closed_by` CHANGED,
 * in replay order.
 *
 * Two callers, each handing it the chains ITS write disturbed:
 * `memory:facts:reindex` passes the chains a newly-resolved pending row
 * joined, and `memory:facts:supersede` ({@link supersedeIds}) passes the
 * chains of the rows it just retracted. Both expect it to run inside a
 * transaction they opened, because in both cases the write and the
 * re-derivation it invalidates are one operation, not two: a crash between
 * them leaves a chain nobody re-settled, which reads as a wrong answer.
 *
 * ## Why a REPLAY in arrival order, not a canonical sort by `valid_start`
 *
 * §3.4's rules are arrival-indexed: they say what an ARRIVING statement does
 * to the chain it finds, and rule 4 says so out loud ("equal `when`: later
 * `transaction_time` wins"). The state they leave behind is therefore
 * genuinely path-dependent, and provenance immunity is where that shows: a
 * human `lives_in` recorded first is never closed by an extracted one that
 * arrives later and is dated earlier, but sort the same two rows by
 * `valid_start` and the human row now closes the extracted one. Both are
 * defensible readings of rule 3 — only one of them is what `record` does.
 *
 * So the replay walks `(transaction_time, batch_seq, id)`, which reproduces
 * `insertWithSlotClosure` exactly. That gives the property that makes pending
 * safe to use at all: resolving a pending row to slot X leaves the store in
 * the state it would have been in had the row been recorded with slot X in
 * the first place. Anything else would make `reindex` a second, quietly
 * different set of closure rules.
 *
 * That ordering is total. `transaction_time` is one stamp per `record` call;
 * `batch_seq` (COALESCEd, since a pre-TASK-422 row has none) separates rows
 * within one batch; `id` is a UUID primary key, so no two rows can tie on all
 * three. The honest limit: two SEPARATE `record` calls landing in the same
 * millisecond at the same batch index fall back to `id`, which is stable but
 * arbitrary rather than truly chronological. `rowid` would not help — SQLite
 * reserves the right to renumber it during VACUUM on this table (see
 * `FactRow.batch_seq`).
 *
 * ## Retractions
 *
 * A row closed by an explicit `memory:facts:supersede` has `closed_by IS NULL`
 * and a finite `valid_end`. It asserts nothing, so it is dropped from the
 * replay entirely: its own `valid_end`/`closed_by` are never rewritten, and it
 * is never a peer, so it can neither close nor bound its neighbours. That is
 * the same exclusion `insertWithSlotClosure`'s peer query makes, and it is the
 * one thing this function must not get wrong — resurrecting a retracted row
 * would un-forget something a person asked us to forget.
 *
 * Consequence worth stating: because a retracted row is absent from the
 * replay, a NEIGHBOUR whose closure was decided by it is re-derived without
 * it. If B closed A and B was then retracted, re-settling that chain reopens
 * A. That is deliberate — B asserts nothing, so nothing should still be closed
 * on B's authority — and it shows up in `resettled`, not silently. It is also
 * why {@link supersedeIds} calls this in the same transaction as the
 * retraction: the re-open is CAUSED by the retraction, so any gap between them
 * is a window in which `recall` returns neither A (closed) nor B (retracted).
 */
export function resettleSlotGroups(
  driver: BetterSqliteDb,
  agentKey: string,
  groups: readonly SlotGroup[],
): string[] {
  if (groups.length === 0) return [];

  const selectGroup = driver.prepare(
    `SELECT id, valid_start, valid_end, provenance, closed_by
       FROM ${TABLE}
      WHERE agent_key = ? AND about = ? AND slot = ? AND slot <> ?
      ORDER BY transaction_time, COALESCE(batch_seq, 0), id`,
  );
  const writeBack = driver.prepare(
    `UPDATE ${TABLE} SET valid_end = ?, closed_by = ? WHERE id = ? AND agent_key = ?`,
  );

  const changed: string[] = [];

  for (const group of groups) {
    const rows = selectGroup.all(agentKey, group.about, group.slot, PENDING_SLOT) as GroupRow[];

    // Replay the chain from nothing. `live` holds only rows that have
    // "arrived" so far, which is exactly the peer set each of them saw.
    const live: Array<{ stored: GroupRow; state: ReplayState }> = [];
    for (const row of rows) {
      const isRetraction = row.closed_by === null && row.valid_end !== INFINITY_SENTINEL;
      if (isRetraction) continue;

      const provenance = row.provenance ?? 'extracted';
      const state: ReplayState = {
        id: row.id,
        valid_start: row.valid_start,
        valid_end: INFINITY_SENTINEL,
        provenance,
        closed_by: null,
      };
      const outcome = settleArrival(
        { id: row.id, when: row.valid_start, provenance },
        live.map((entry) => entry.state),
      );
      // `settleArrival` hands back the state objects themselves, so rule 1 is
      // applied by mutating the peers in place — no id lookup, no chance of
      // updating a row the rules did not name.
      for (const peer of outcome.closed) {
        peer.valid_end = row.valid_start;
        peer.closed_by = row.id;
      }
      if (outcome.bound !== null) {
        state.valid_end = outcome.bound.valid_start;
        state.closed_by = outcome.bound.id;
      }
      live.push({ stored: row, state });
    }

    // Write back only what moved, so `resettled` means "this row's closure
    // actually changed" and a second identical reindex is a true no-op.
    for (const { stored, state } of live) {
      if (state.valid_end === stored.valid_end && state.closed_by === stored.closed_by) continue;
      writeBack.run(state.valid_end, state.closed_by, stored.id, agentKey);
      changed.push(stored.id);
    }
  }

  return changed;
}

/** What one {@link supersedeIds} call did — the retraction and the repair it forced. */
export interface SupersedeResult {
  /** Ids this call actually closed; a foreign, missing or already-closed id is absent. */
  closed: string[];
  /** Ids whose closure CHANGED as a fallout of those retractions — see {@link resettleSlotGroups}. */
  resettled: string[];
}

/**
 * Explicit close — the only way a row ends without a successor. `closed_by`
 * stays NULL, which is what distinguishes "superseded by that row" from
 * "somebody retracted this". Returns the ids it actually closed, so a caller
 * handed a foreign or already-closed id learns that rather than assuming.
 *
 * ## Why it also re-settles (TASK-448)
 *
 * Ending a row is not the whole of retracting it. Closures the retracted row
 * had itself AUTHORED — neighbours carrying `closed_by = <this id>` — would
 * otherwise stay exactly as they are, still ended on the authority of a row
 * that now asserts nothing:
 *
 * ```
 * A = lives_in Boston  (JAN)
 * B = lives_in Seattle (JUN)  -> rule 1 closes A: until=JUN, closed_by=B
 * supersede([B])              -> B retracted
 * ```
 *
 * `recall` then returns NEITHER — A is closed, B is retracted — which the
 * person experiences as "I deleted the new fact and my old one disappeared
 * too". An empty answer where A is the correct one.
 *
 * So the retraction and the re-derivation it invalidates happen together, in
 * the transaction below: collect the `(about, slot)` chains of the rows this
 * call actually closed, hand them to {@link resettleSlotGroups}, and report
 * what moved. Leaving it to a later `memory:facts:reindex` was the shape
 * TASK-422 shipped, and its window had no bound — a `reindex` re-settles only
 * the chains a newly-resolved PENDING row joined, so a chain with no pending
 * row was never revisited at all.
 *
 * Two things the collection deliberately skips, because neither has a chain to
 * re-derive (see {@link insertWithSlotClosure}'s early-out): a row with no
 * slot, and a row still carrying {@link PENDING_SLOT}. Both are inert — they
 * close nothing and nothing closes them — so retracting one strands nothing.
 *
 * The just-retracted rows are themselves retractions by the time the replay
 * reads them (`closed_by IS NULL`, finite `valid_end`), so `resettleSlotGroups`
 * drops them from the replay and never rewrites their own two columns. That is
 * what keeps a retraction a retraction rather than something the repair pass
 * re-derives back into existence.
 *
 * Idempotent by construction: a second `supersede` of the same ids closes
 * nothing — the `valid_end = INFINITY_SENTINEL` predicate no longer matches —
 * so it collects no chains and re-settles nothing.
 *
 * ## Owner scope (design §6.1)
 *
 * `ownerUserId`, when the caller supplies one, joins the tenant key in the
 * UPDATE's own predicate — and in the `readGroup` read-back that follows it,
 * so the two statements agree on which rows exist. Putting it in the SQL is
 * what keeps `changes > 0` the SINGLE authority on what this call closed: a
 * foreign-owner id fails to match, so it is never added to `closed` and its
 * chain is never collected. Checking the owner in application code instead
 * would mean reading the row, comparing, and then deciding — three steps that
 * can disagree with each other, replacing one atomic test with a race.
 *
 * A foreign-owner id is therefore REFUSED in exactly the sense a foreign-tenant
 * id already is: silently absent from `closed`, no throw. Same shape, one
 * thing for a caller to handle. And `=` is strict, so an unstamped row is not
 * closable by an owner-scoped call — unowned is not provably yours.
 */
export function supersedeIds(
  driver: BetterSqliteDb,
  agentKey: string,
  ids: readonly string[],
  at: string,
  ownerUserId?: string,
): SupersedeResult {
  if (ids.length === 0) return { closed: [], resettled: [] };
  const close = driver.transaction((): SupersedeResult => {
    const closed: string[] = [];
    // Deduped by `(about, slot)`: several retracted rows of one chain
    // re-derive it ONCE. Not for correctness — the replay is idempotent, so a
    // second pass over the same chain finds nothing left to move and adds
    // nothing to `resettled` — but because that second pass re-reads and
    // re-settles every row in the chain to reach that conclusion. The Map
    // costs less than the query it saves. Keyed structurally
    // (`JSON.stringify([about, slot])`), not by joining the two fields with a
    // delimiter: `about` is free text that can carry model output, and ANY
    // in-band delimiter — including NUL — is only injective if the fields are
    // guaranteed not to contain it. Legacy stored fields may still contain NUL. `about =
    // "x\u0000y", slot = "z"` and `about = "x", slot = "y\u0000z"` produce the
    // same NUL-joined string but different JSON arrays (same reasoning as the
    // drain's group map in `plugin.ts`).
    const groups = new Map<string, SlotGroup>();

    // The owner predicate is spliced into BOTH statements or neither, so the
    // read-back can never see a row the UPDATE could not have touched.
    const ownerClause = ownerUserId === undefined ? '' : ' AND owner_user_id = ?';
    const ownerParams: string[] = ownerUserId === undefined ? [] : [ownerUserId];

    const statement = driver.prepare(
      `UPDATE ${TABLE} SET valid_end = ?
        WHERE id = ? AND agent_key = ?${ownerClause} AND valid_end = ?`,
    );
    // Read back AFTER the UPDATE, keyed on the same tenant AND owner scope, so
    // the `changes > 0` test stays the single authority on what this call
    // closed: the chain is collected for rows it really retracted, never for a
    // foreign, foreign-owner, or already-closed id it merely looked at.
    const readGroup = driver.prepare(
      `SELECT about, slot FROM ${TABLE} WHERE id = ? AND agent_key = ?${ownerClause}`,
    );

    for (const id of ids) {
      if (statement.run(at, id, agentKey, ...ownerParams, INFINITY_SENTINEL).changes === 0) continue;
      closed.push(id);
      const row = readGroup.get(id, agentKey, ...ownerParams) as
        | { about: string; slot: string | null }
        | undefined;
      // `undefined` is unreachable — the UPDATE just matched this row inside
      // this transaction — and is handled rather than asserted because the
      // honest fallback (skip the chain) is the same one a slotless row takes.
      if (row === undefined || row.slot === null || row.slot === PENDING_SLOT) continue;
      groups.set(JSON.stringify([row.about, row.slot]), { about: row.about, slot: row.slot });
    }

    // The REPLAY stays tenant-scoped on purpose, and it is the one place the
    // owner predicate deliberately stops. A `(about, slot)` chain belongs to
    // the TENANT — the contract pins that two people on one agent share ONE
    // slot history, not two private shards — so re-deriving it over only one
    // owner's rows would invent a second, quietly different set of closure
    // rules for owner-scoped retractions. Owner scope decides WHAT this caller
    // may retract; it does not get to change what the remaining rows then mean.
    return { closed, resettled: resettleSlotGroups(driver, agentKey, [...groups.values()]) };
  });
  return close();
}
