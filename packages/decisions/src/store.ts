/**
 * @ax/decisions store.
 *
 * A plain Kysely mapper with two properties worth stating out loud:
 *
 *   1. EVERY state change is a CONDITIONAL update — `WHERE decision_id = $1 AND
 *      status IN (...)` — returning the row it changed, or nothing. That is
 *      what makes "approving twice sends once" true across two browser tabs
 *      and a retried POST, rather than only inside one process's copy of the
 *      state machine.
 *
 *   2. No `Date` ever leaves this file. Timestamps cross the boundary as ISO
 *      strings, because a `Date` in a hook payload is a storage detail and
 *      serialises differently depending on who is doing the serialising.
 *
 * Reads are scoped by `owner_user_id` wherever a caller supplies one; the
 * plugin always does. User A's queries must never touch user B's rows.
 */
import { sql, type Kysely } from 'kysely';
import type { DecisionRow, DecisionsDatabase } from './migrations.js';
import { RECEIPT_STATUSES } from './receipts.js';
import {
  AUTHORISING_STATUSES,
  type Decision,
  type DecisionStatus,
  type FreshnessPredicate,
  type ToolCall,
} from './types.js';

/** The two statuses a human can still act on. */
const OPEN_STATUSES: readonly DecisionStatus[] = ['pending', 'stale'];

/**
 * SQLSTATE for a unique-violation. The one storage code this file translates.
 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * `claimForApproval` refused because a standing authorisation for this
 * (agent, call shape) ALREADY EXISTS — the partial unique index doing its job.
 *
 * A TYPED ERROR RATHER THAN A DRIVER CODE THE CALLER SNIFFS, and the reason is
 * invariant 1. `decisions:approve` has to tell this refusal apart from every
 * other way a write can fail, because it reports the two differently — a
 * standing authorisation is a sentence for a person, and a deadlock is a fault
 * for an operator. Letting the caller read `err.code === '23505'` would put
 * Postgres vocabulary in the plugin and quietly make every alternate store
 * impl responsible for reproducing a pg SQLSTATE. So the store, which is the
 * only file allowed to know what backs it, says what happened in the
 * vocabulary of the decision.
 *
 * EVERYTHING ELSE PROPAGATES UNTRANSLATED. That asymmetry is the point: a
 * deadlock, a lock timeout, a statement timeout or a dropped table is a fault,
 * and a fault that is renamed "already approved" tells the person the exact
 * thing that will stop them retrying — under precisely the turbulence
 * (eviction, failover, load) this whole area exists for.
 */
export class DuplicateAuthorisationError extends Error {
  constructor(decisionId: string, cause: unknown) {
    super(`a standing authorisation already exists for decision '${decisionId}'`, {
      cause,
    });
    this.name = 'DuplicateAuthorisationError';
  }
}

/** Does this driver error say "you broke a unique index"? */
function isUniqueViolation(err: unknown): boolean {
  // Duck-typed rather than `instanceof pg.DatabaseError`: this file talks to
  // Kysely, and importing the driver's error class to read one string would be
  // a dependency on the dialect rather than on the database. Only one unique
  // index can be violated by the UPDATE below — `decisions_v1_decisions`'
  // primary key is never rewritten by it — so the code alone is unambiguous.
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/** The statuses `restore()` (undo) can walk back from. */
const UNDOABLE_STATUSES: readonly DecisionStatus[] = [
  ...AUTHORISING_STATUSES,
  'dismissed',
];

export interface DecisionListFilter {
  ownerUserId: string;
  agentId?: string | undefined;
  /** Exact status. Omitted means the open ones. */
  status?: DecisionStatus | undefined;
}

/**
 * One agent's resolved decisions, newest first, one page at a time.
 *
 * A separate filter from `DecisionListFilter` rather than three optional fields
 * bolted onto it: the queue read is "what is still open for this person",
 * oldest first and unpaginated because a queue that needs paging is a queue
 * nobody is answering. This one is history, newest first, and it has to page —
 * two different questions, and merging them would leave every caller reading
 * the doc comment to find out which one it was asking.
 */
export interface DecisionReceiptFilter {
  ownerUserId: string;
  agentId: string;
  /** Page size. Already clamped by the caller. */
  limit: number;
  /**
   * ISO instant, EXCLUSIVE — strictly older than this. An instant rather than
   * a row id, so nothing here is tied to how the rows happen to be stored.
   */
  before?: string | undefined;
}

export interface DecisionStore {
  create(decision: Decision): Promise<Decision>;
  /** `ownerUserId`, when given, is a scope filter and not a hint. */
  get(decisionId: string, ownerUserId?: string): Promise<Decision | null>;
  list(filter: DecisionListFilter): Promise<Decision[]>;

  /**
   * The rows a receipt can be derived from, newest resolution first.
   *
   * The filter is `receiptFor`'s rule pushed into SQL — the receipt-bearing
   * statuses, AND an `executed` row only once its call has actually gone out
   * (`replayed_at` for the host, `consumed_at` for the agent). Doing it here
   * rather than fetching a page and discarding most of it is what makes a page
   * exactly a page: rows dropped after the LIMIT under-fill it, and a feed
   * paging through under-filled pages stalls short of history it has.
   *
   * That puts one rule in two languages, which `receipts.test.ts` and
   * `store.test.ts` both pin. It is the same deliberate duplication
   * `decisions:undo` already carries against `restore`'s predicates: the store
   * is the guarantee under concurrency, the function is the one a reader can
   * follow.
   *
   * Ordered by `resolved_at` — the instant the receipt is filed under — with
   * `decision_id` as the tie-break so two decisions answered in the same
   * millisecond have a stable order rather than a page boundary that shuffles.
   */
  listReceiptCandidates(filter: DecisionReceiptFilter): Promise<Decision[]>;

  /**
   * THE claim. A single conditional `UPDATE ... WHERE status IN ('pending',
   * 'stale') RETURNING *`, so of two concurrent approvals exactly one gets a
   * row back and only that one is entitled to run anything.
   *
   * **A null return means SOMEONE ELSE RESOLVED IT, not "no such row".** The
   * caller must re-read and report the stored outcome; reporting "decision not
   * found" for a decision the human is looking at is a lie about state we
   * actually have.
   *
   * `status` is the terminal status to claim into: `'executed'` when the call
   * has run or is about to, `'approved-pending-agent'` when the host cannot
   * replay it and the agent will perform it on its next run. Both carry a
   * standing authorisation, so both live under the partial unique index — and
   * this throws `DuplicateAuthorisationError` if one already exists for this
   * (agent, call fingerprint). Refusing loudly is the point.
   *
   * ANY OTHER FAILURE COMES BACK AS ITSELF. Only the index's refusal is
   * translated; a deadlock, a lock timeout or an unreachable database is a
   * fault and must reach the caller as one, because the caller reports the two
   * differently and the wrong label is what stops a person retrying.
   *
   * `replayDueAt` defers the host replay until the undo window closes, for an
   * irreversible call. `replayClaimedAt` is its opposite number: the host is
   * taking the replay NOW, so the row is closed to the agent's gate and to undo
   * from this instant. Exactly one of the two is set on a host-replay claim,
   * and neither is set on the attended or parked paths.
   */
  claimForApproval(
    decisionId: string,
    opts: {
      nowIso: string;
      status: 'executed' | 'approved-pending-agent';
      replayDueAt?: string | null;
      replayClaimedAt?: string | null;
    },
  ): Promise<Decision | null>;

  /**
   * TAKE THE FLIGHT on a row that is already claimed — stamp `replay_claimed_at`
   * on an `executed` row nobody has consumed, nobody has taken, and nothing has
   * replayed.
   *
   * `claimForApproval` sets this in the same statement that claims the row,
   * which is right for every path that knows at claim time that the host is
   * making the call. TASK-277 added one that does not: an ATTENDED approval
   * claims with `replay_claimed_at` null (it expects the warm agent to run the
   * call), then discovers the delivery failed and takes the replay itself. That
   * row sits `executed` with every marker null, which is precisely the shape
   * `restore` accepts — so without this write an undo landing during the host
   * tool would report success over a call already going out.
   *
   * IT GUARDS THE SAME THREE COLUMNS AS ITS SIBLINGS, and that symmetry is the
   * point rather than a coincidence. `restore` and `takeApproval` each refuse a
   * row on all of `{consumed_at, replayed_at, replay_claimed_at}`; a guard here
   * that checked only two would let a byte-identical agent call consume the
   * authorisation through `takeApproval` in the window before this write, and
   * then this write would take the flight on top of it and the call would go
   * out TWICE. Three guards over the same three columns is also the shape the
   * next reader will assume — a fourth that quietly checks fewer is a trap.
   *
   * A null return is NOT an error and never means "no such row": undo, a
   * consuming agent, or another resolver got there first. The caller must
   * report the stored outcome and MUST NOT replay.
   *
   * The status predicate refuses an ALREADY-PARKED row, which is a different
   * question from whether the caller should ask at all (see the call site).
   * `approved-pending-agent` is the agent's to perform, and a flight stamped on
   * it would never be cleared — no later `parkForAgent` is coming — so
   * `takeApproval` would refuse the agent forever and the call would run zero
   * times.
   */
  claimReplayFlight(decisionId: string, nowIso: string): Promise<Decision | null>;

  /**
   * The host replay threw. Records the failure and DROPS the standing
   * authorisation with it (the partial index does not cover `failed`), because
   * an action that did not happen must not leave behind a yes the agent can
   * quietly cash in later.
   */
  markFailed(
    decisionId: string,
    opts: { error: string | null },
  ): Promise<Decision | null>;

  /**
   * The host replay succeeded. Stamps `replayed_at`, which is what takes the
   * row OUT of the standing-authorisation set: the call has been made, so a
   * later identical agent call must not cash in the same yes, and an undo must
   * not put it back on the queue for a second run.
   *
   * NOT conditional on the current status, deliberately, and the only write in
   * this file that is not. Once the call has gone out that is a fact about the
   * world and the row has to agree with it, whatever the row currently says.
   *
   * Belt-and-braces rather than load-bearing, as of the `replay_claimed_at`
   * guard: `restore` now refuses any row the host has taken, so an undo can no
   * longer land between the executor returning and this write. It stays
   * unconditional because "the send happened" is not a claim that should ever
   * depend on winning a race — the same rule `consumed_at` already enforces:
   * that bell cannot be un-rung. Returns `null` only when the row is gone.
   */
  markReplayed(decisionId: string, nowIso: string): Promise<Decision | null>;

  /**
   * A claimed decision the host turns out not to be able to replay after all —
   * its executor went away between the approval and the deferred replay. The
   * approval still stands; the agent performs it on its next run. Reachable
   * only from `executed`.
   */
  parkForAgent(decisionId: string): Promise<Decision | null>;

  markDismissed(decisionId: string, nowIso: string): Promise<Decision | null>;
  /**
   * The freshness guard tripped. NOT a resolution — the decision re-opens, so
   * `resolved_at` stays null and no undo window ever opens on something that
   * did not happen.
   */
  markStale(
    decisionId: string,
    opts: { staleReason: string; freshness: FreshnessPredicate | null },
  ): Promise<Decision | null>;
  markExpired(decisionId: string, nowIso: string): Promise<Decision | null>;

  /**
   * Undo — back to `pending`, which also drops the standing authorisation (the
   * partial index covers only the two authorising statuses) and cancels any
   * deferred replay. Refuses once the call has actually been made — either
   * `consumed_at` (the agent ran it) or `replayed_at` (the host ran it). That
   * bell cannot be un-rung, and re-approving afterwards would authorise a
   * SECOND execution of a call that already ran.
   */
  restore(decisionId: string): Promise<Decision | null>;

  /** Sweep: every open decision past its expiry. Returns how many moved. */
  expireDue(nowIso: string): Promise<number>;

  /**
   * Claim every deferred replay whose undo window has closed, CLEARING
   * `replay_due_at` in the same statement so a second replica running the same
   * sweep gets an empty list rather than a duplicate send.
   *
   * The cost of that atomicity: a host that dies between the claim and the
   * replay loses the replay — on this path and on the immediate one alike. The
   * row is left `executed`, claimed, and un-replayed, which means three things
   * worth knowing before someone investigates it as a bug:
   *
   *   * nothing retries it (the claim already cleared `replay_due_at`) and
   *     nothing consumes it, so the call runs ZERO times;
   *   * it cannot be undone (`restore` refuses a claimed row);
   *   * it keeps occupying its `(agent, fingerprint)` slot in the partial
   *     unique index, so a fresh hold of the same call cannot be approved —
   *     the claim collides and `decisions:approve` absorbs it, saying why
   *     (`CLAIM_REFUSED_DETAIL`) but resolving nothing.
   *
   * All of that is wrong in the SAFE direction — visible inaction rather than a
   * silent double-send, which is what a lease-and-reaper scheme risks. What
   * TASK-253 added is not a retry, for exactly that reason: see
   * `reclaimStrandedFlights`, which gives the row up rather than re-running it,
   * and hands the slot back.
   */
  claimDueReplays(nowIso: string, limit: number): Promise<Decision[]>;

  /**
   * GIVE UP on flights nobody is flying — the recovery `claimDueReplays` above
   * describes the need for (TASK-253).
   *
   * A stranded row is `executed`, claimed, un-replayed and unconsumed, left by a
   * host that died between taking the flight and recording what happened. Three
   * paths can produce one, and all three end at the same shape: the `immediate`
   * claim in `decisions:approve`, this file's `claimDueReplays`, and TASK-277's
   * `claimReplayFlight` on the attended fallback.
   *
   * IT MOVES THE ROW TO `failed`. IT DOES NOT RETRY IT, AND THAT IS THE ENTIRE
   * SAFETY ARGUMENT. We cannot know which side of the tool's own side effect
   * the crash landed on — the executor may have returned microseconds before
   * the process died — so re-running the call is a coin-flip on a double send,
   * which on this surface is strictly worse than the bug being fixed. Because
   * nothing here runs anything, reclaiming a row EARLY cannot execute a call
   * twice on its own: the worst it can do is release an authorisation a
   * still-running flight was holding, and even then a human has to approve the
   * same call again before a second one goes out.
   *
   * `claimedBeforeIso` is the caller's age cutoff and it is belt to that
   * braces: `HookBus` bounds every service call at 120 s by default, so a flight
   * older than a cutoff comfortably past that ceiling cannot still be inside its
   * `bus.call` in any host, this one or another replica. See
   * `STRANDED_REPLAY_TIMEOUT_MS`.
   *
   * The predicates are the same three columns `restore`, `takeApproval` and
   * `claimReplayFlight` guard, for the same reason — plus the age comparison,
   * which is also what keeps every ATTENDED approval out of reach: those are
   * `executed`, unconsumed, un-replayed and arbitrarily old, they carry no
   * flight, and nothing is wrong with them.
   *
   * `replay_error` is deliberately left alone. It carries the TOOL's words, and
   * no tool ever spoke here.
   */
  reclaimStrandedFlights(opts: {
    /** Stamped as `replayAbandonedAt`, which is what the receipt reads. */
    nowIso: string;
    /** INCLUSIVE — a flight taken at this instant has been out long enough. */
    claimedBeforeIso: string;
    limit: number;
  }): Promise<Decision[]>;

  /**
   * Consume the standing authorisation for this (agent, call shape), if there
   * is one. A SINGLE conditional UPDATE...RETURNING, so two concurrent callers
   * — the warm agent retrying its call and (from AW-5) a host replay — cannot
   * both win.
   */
  takeApproval(
    agentId: string,
    callFingerprint: string,
    nowIso: string,
  ): Promise<Decision | null>;
}

export function createDecisionsStore(db: Kysely<DecisionsDatabase>): DecisionStore {
  const table = 'decisions_v1_decisions' as const;

  async function transition(
    decisionId: string,
    from: readonly DecisionStatus[],
    set: Partial<DecisionRow>,
  ): Promise<Decision | null> {
    const row = await db
      .updateTable(table)
      .set(set)
      .where('decision_id', '=', decisionId)
      .where('status', 'in', from as string[])
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toDecision(row);
  }

  /** The claim itself, unwrapped. `claimForApproval` owns the translation. */
  function claim(
    decisionId: string,
    opts: {
      nowIso: string;
      status: 'executed' | 'approved-pending-agent';
      replayDueAt?: string | null | undefined;
      replayClaimedAt?: string | null | undefined;
    },
  ): Promise<Decision | null> {
    const { nowIso, status, replayDueAt, replayClaimedAt } = opts;
    return transition(decisionId, OPEN_STATUSES, {
      status,
      resolved_at: new Date(nowIso),
      // The guard passed, so whatever it said last time is no longer true.
      stale_reason: null,
      replay_due_at:
        replayDueAt === undefined || replayDueAt === null ? null : new Date(replayDueAt),
      replay_claimed_at:
        replayClaimedAt === undefined || replayClaimedAt === null
          ? null
          : new Date(replayClaimedAt),
      // A re-approval after an undo starts clean; a leftover failure detail
      // from a previous attempt would describe a run that is no longer the
      // one this row is about.
      replay_error: null,
    });
  }

  return {
    async create(decision) {
      await db.insertInto(table).values(fromDecision(decision)).execute();
      return decision;
    },

    async get(decisionId, ownerUserId) {
      let q = db.selectFrom(table).selectAll().where('decision_id', '=', decisionId);
      if (ownerUserId !== undefined) q = q.where('owner_user_id', '=', ownerUserId);
      const row = await q.executeTakeFirst();
      return row === undefined ? null : toDecision(row);
    },

    async list({ ownerUserId, agentId, status }) {
      let q = db.selectFrom(table).selectAll().where('owner_user_id', '=', ownerUserId);
      if (agentId !== undefined) q = q.where('agent_id', '=', agentId);
      q =
        status !== undefined
          ? q.where('status', '=', status)
          : q.where('status', 'in', OPEN_STATUSES as string[]);
      // Oldest first: the queue is a queue, and the thing that has been
      // waiting longest is the thing most likely to be about to expire.
      const rows = await q.orderBy('created_at', 'asc').orderBy('decision_id', 'asc').execute();
      return rows.map(toDecision);
    },

    async listReceiptCandidates({ ownerUserId, agentId, limit, before }) {
      let q = db
        .selectFrom(table)
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        // A receipt is filed under the instant the person answered, so a row
        // with no such instant has nothing to be filed under. In practice every
        // row in the statuses below carries one; the predicate is here because
        // the ORDER BY depends on it and a null would sort unpredictably.
        .where('resolved_at', 'is not', null)
        .where('status', 'in', RECEIPT_STATUSES as string[]);
      if (before !== undefined) q = q.where('resolved_at', '<', new Date(before));
      const rows = await q
        // The one status that is not on its own enough: `executed` is written
        // the moment a human says yes, and on two paths the call has not gone
        // out yet — an irreversible one waiting out its undo window, and an
        // attended one waiting for its warm agent. Neither has anything to
        // report, and both are still undoable.
        .where((eb) =>
          eb.or([
            eb('status', '!=', 'executed'),
            eb('replayed_at', 'is not', null),
            eb('consumed_at', 'is not', null),
          ]),
        )
        .orderBy('resolved_at', 'desc')
        .orderBy('decision_id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toDecision);
    },

    async claimForApproval(decisionId, { nowIso, status, replayDueAt, replayClaimedAt }) {
      try {
        return await claim(decisionId, { nowIso, status, replayDueAt, replayClaimedAt });
      } catch (err) {
        // Translate ONLY the index's refusal. `throw err` for everything else
        // is not a fallthrough — it is the branch that keeps a transient write
        // failure from being reported as a standing authorisation.
        if (isUniqueViolation(err)) throw new DuplicateAuthorisationError(decisionId, err);
        throw err;
      }
    },

    async claimReplayFlight(decisionId, nowIso) {
      const row = await db
        .updateTable(table)
        .set({ replay_claimed_at: new Date(nowIso) })
        .where('decision_id', '=', decisionId)
        // `executed` only. A parked row is the agent's to perform, and a failed
        // or re-opened one has nothing in flight to take.
        .where('status', '=', 'executed')
        // The AGENT has not already spent this yes. `takeApproval` needs only
        // `replay_claimed_at IS NULL` to consume a row, so between the claim
        // and this write a byte-identical agent call can win it — and taking
        // the flight on top of that would send the call twice.
        .where('consumed_at', 'is', null)
        // Nobody else has taken it — including this row's own claim, on the
        // paths where the host knew at claim time that it was replaying.
        .where('replay_claimed_at', 'is', null)
        // And nothing has already gone out under it.
        .where('replayed_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toDecision(row);
    },

    async markReplayed(decisionId, nowIso) {
      const row = await db
        .updateTable(table)
        .set({
          status: 'executed',
          replayed_at: new Date(nowIso),
          replay_due_at: null,
          replay_error: null,
          // AND THE ROW IS NO LONGER ABANDONED, because it just came back.
          //
          // The race is real rather than theoretical: a host frozen long enough
          // for the sweep to give up on it (`reclaimStrandedFlights` wrote
          // `failed` + `replay_abandoned_at`) can still thaw and land this
          // write, which is unconditional on status precisely so the world wins.
          // Leaving the stamp behind would produce an `executed` row carrying a
          // marker whose whole meaning is "we gave up on this" — harmless to
          // `receiptFor`, which keys the abandoned sentence on `failed`, and a
          // straight contradiction of what `Decision.replayAbandonedAt` says
          // about itself. Same rule as the two clears above: the call went out,
          // so nothing about this row is pending, failed, or given up on.
          replay_abandoned_at: null,
          // Keep the ORIGINAL resolution instant. Overwriting it would restart
          // the undo window AFTER the outward action, which is the one thing
          // the deferral exists to prevent.
          resolved_at: sql`COALESCE(resolved_at, ${new Date(nowIso)})`,
        })
        .where('decision_id', '=', decisionId)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toDecision(row);
    },

    parkForAgent(decisionId) {
      return transition(decisionId, ['executed'], {
        status: 'approved-pending-agent',
        replay_due_at: null,
        // RELINQUISH the flight. This is only ever reached from inside
        // `settleReplay`, i.e. on a row the host had already CLAIMED — so
        // leaving `replay_claimed_at` set would park a decision the agent is
        // then forbidden to pick up, and the call would run zero times. Parking
        // means the host is handing it back without having sent anything, so
        // the in-flight marker has to drop with it.
        replay_claimed_at: null,
      });
    },

    markFailed(decisionId, { error }) {
      return transition(decisionId, ['executed'], {
        status: 'failed',
        replay_error: error,
        replay_due_at: null,
      });
    },

    markDismissed(decisionId, nowIso) {
      return transition(decisionId, OPEN_STATUSES, {
        status: 'dismissed',
        resolved_at: new Date(nowIso),
      });
    },

    markStale(decisionId, { staleReason, freshness }) {
      return transition(decisionId, OPEN_STATUSES, {
        status: 'stale',
        stale_reason: staleReason,
        freshness_json: freshness === null ? null : JSON.stringify(freshness),
        resolved_at: null,
      });
    },

    markExpired(decisionId, nowIso) {
      return transition(decisionId, OPEN_STATUSES, {
        status: 'expired',
        resolved_at: new Date(nowIso),
      });
    },

    async restore(decisionId) {
      const row = await db
        .updateTable(table)
        .set({
          status: 'pending',
          resolved_at: null,
          stale_reason: null,
          // Cancels a deferred replay outright. This is the whole reason an
          // irreversible call waits out the undo window before it runs: an
          // undo inside the window has to stop the outward action, not
          // apologise for it afterwards.
          replay_due_at: null,
          replay_error: null,
        })
        .where('decision_id', '=', decisionId)
        .where('status', 'in', UNDOABLE_STATUSES as string[])
        .where('consumed_at', 'is', null)
        // The host already made the call. Undo cannot un-send it, and putting
        // the row back on the queue would let a second approval do it AGAIN —
        // the same bell-cannot-be-un-rung rule `consumed_at` enforces for the
        // agent's side of the authorisation.
        .where('replayed_at', 'is', null)
        // Nor can it be un-sent while it is IN FLIGHT. A row the host has taken
        // is a call already on its way out; undoing it would put a decision
        // back on the queue that is about to be stamped `executed` underneath
        // the person who thought they had stopped it.
        .where('replay_claimed_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toDecision(row);
    },

    async expireDue(nowIso) {
      const res = await db
        .updateTable(table)
        .set({ status: 'expired', resolved_at: new Date(nowIso) })
        .where('status', 'in', OPEN_STATUSES as string[])
        .where('expires_at', '<=', new Date(nowIso))
        .executeTakeFirst();
      return Number(res.numUpdatedRows ?? 0n);
    },

    async claimDueReplays(nowIso, limit) {
      const due = await db
        .selectFrom(table)
        .select('decision_id')
        .where('status', '=', 'executed')
        .where('replay_due_at', 'is not', null)
        .where('replay_due_at', '<=', new Date(nowIso))
        .where('replay_claimed_at', 'is', null)
        .orderBy('replay_due_at', 'asc')
        .limit(limit)
        .execute();
      if (due.length === 0) return [];

      // The claim. Clearing `replay_due_at` and stamping `replay_claimed_at` in
      // one statement, with both as predicates, is what makes it one-shot: a
      // second sweep — in this process or another replica — matches nothing.
      // And the stamp is what closes the row to the agent's gate for the whole
      // time the call is in flight.
      const rows = await db
        .updateTable(table)
        .set({ replay_due_at: null, replay_claimed_at: new Date(nowIso) })
        .where(
          'decision_id',
          'in',
          due.map((d) => d.decision_id),
        )
        .where('status', '=', 'executed')
        .where('replay_due_at', 'is not', null)
        .where('replay_claimed_at', 'is', null)
        .returningAll()
        .execute();
      return rows.map(toDecision);
    },

    async reclaimStrandedFlights({ nowIso, claimedBeforeIso, limit }) {
      // Select then update, the same two steps `claimDueReplays` takes and for
      // the same reason: Postgres has no `UPDATE ... LIMIT`, and a maintenance
      // sweep that can rewrite an unbounded number of rows in one statement is
      // a sweep that eventually takes the table with it.
      const stale = await db
        .selectFrom(table)
        .select('decision_id')
        .where('status', '=', 'executed')
        // THE PREDICATE THAT MAKES THIS A STRANDED FLIGHT and not simply an old
        // approval. An attended `executed` row waits for its warm agent with
        // `replay_claimed_at` NULL, for as long as it takes — and `NULL <=
        // anything` is unknown, so this comparison excludes every one of them
        // as well as every flight that is merely too recent. Failing an
        // attended row would cancel a yes nobody withdrew; `store.test.ts`
        // pins both halves.
        .where('replay_claimed_at', '<=', new Date(claimedBeforeIso))
        // Nothing went out under it…
        .where('replayed_at', 'is', null)
        // …and the agent did not spend it either. Unreachable together with a
        // flight through this file's own writes today; the predicate is here so
        // that a fourth path producing the shape cannot cancel an authorisation
        // that has already been cashed.
        .where('consumed_at', 'is', null)
        .orderBy('replay_claimed_at', 'asc')
        .limit(limit)
        .execute();
      if (stale.length === 0) return [];

      const rows = await db
        .updateTable(table)
        .set({
          status: 'failed',
          replay_abandoned_at: new Date(nowIso),
          // A stranded row never has one, but mirroring `markFailed` keeps
          // "a terminal row has nothing pending" true on every terminal write
          // rather than on nearly every one.
          replay_due_at: null,
        })
        .where(
          'decision_id',
          'in',
          stale.map((d) => d.decision_id),
        )
        // Re-stated, not assumed: between the read above and this write another
        // replica's sweep, a returning executor's `markReplayed`, or a
        // consuming agent could have moved the row. Whoever moved it owns what
        // it says, and this write must then match nothing.
        .where('status', '=', 'executed')
        .where('replay_claimed_at', '<=', new Date(claimedBeforeIso))
        .where('replayed_at', 'is', null)
        .where('consumed_at', 'is', null)
        .returningAll()
        .execute();
      return rows.map(toDecision);
    },

    async takeApproval(agentId, callFingerprint, nowIso) {
      const row = await db
        .updateTable(table)
        .set({ consumed_at: new Date(nowIso) })
        .where('agent_id', '=', agentId)
        .where('call_fingerprint', '=', callFingerprint)
        // Both authorising statuses. `approved-pending-agent` exists precisely
        // so the agent can take the call up on its next run — refusing it here
        // would make the status a dead end and the receipt a lie.
        .where('status', 'in', AUTHORISING_STATUSES as string[])
        .where('consumed_at', 'is', null)
        // A deferred replay has not run yet, and the host still intends to run
        // it. Letting the agent consume the authorisation underneath it is how
        // one approval becomes two sends.
        .where('replay_due_at', 'is', null)
        // And a replay the host has TAKEN — one that is in flight right now —
        // is the same hazard with a much shorter fuse. The window between the
        // host committing to the call and the call returning is small, but a
        // concurrent byte-identical agent call lands squarely in it.
        .where('replay_claimed_at', 'is', null)
        // And a replay that ALREADY ran leaves nothing to authorise. Without
        // this, an agent making the identical call on its next run would sail
        // through the gate on a yes the host already spent.
        .where('replayed_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toDecision(row);
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function fromDecision(d: Decision): DecisionRow {
  return {
    decision_id: d.id,
    agent_id: d.agentId,
    owner_user_id: d.ownerUserId,
    conversation_id: d.conversationId,
    kind: d.kind,
    attendance: d.attendance,
    status: d.status,
    call_json: JSON.stringify(d.call),
    call_fingerprint: d.callFingerprint,
    rule_id: d.ruleId,
    freshness_json: d.freshness === null ? null : JSON.stringify(d.freshness),
    summary: d.summary,
    detail: d.detail,
    preview_json: d.preview === null ? null : JSON.stringify(d.preview),
    primary_label: d.primaryLabel,
    secondary_label: d.secondaryLabel,
    ghost_label: d.ghostLabel,
    approved_text: d.approvedText,
    dismissed_text: d.dismissedText,
    stale_reason: d.staleReason,
    created_at: new Date(d.createdAt),
    expires_at: new Date(d.expiresAt),
    resolved_at: d.resolvedAt === null ? null : new Date(d.resolvedAt),
    consumed_at: d.consumedAt === null ? null : new Date(d.consumedAt),
    irreversible: d.irreversible,
    replay_due_at: d.replayDueAt === null ? null : new Date(d.replayDueAt),
    replay_claimed_at:
      d.replayClaimedAt === null ? null : new Date(d.replayClaimedAt),
    replayed_at: d.replayedAt === null ? null : new Date(d.replayedAt),
    replay_abandoned_at:
      d.replayAbandonedAt === null ? null : new Date(d.replayAbandonedAt),
    replay_error: d.replayError,
  };
}

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.decision_id,
    agentId: row.agent_id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    kind: row.kind === 'grant' ? 'grant' : 'action',
    attendance: row.attendance === 'unattended' ? 'unattended' : 'attended',
    status: row.status as DecisionStatus,
    call: JSON.parse(row.call_json) as ToolCall,
    callFingerprint: row.call_fingerprint,
    ruleId: row.rule_id,
    freshness:
      row.freshness_json === null
        ? null
        : (JSON.parse(row.freshness_json) as FreshnessPredicate),
    summary: row.summary,
    detail: row.detail,
    preview:
      row.preview_json === null
        ? null
        : (JSON.parse(row.preview_json) as { meta: string; body: string }),
    primaryLabel: row.primary_label,
    secondaryLabel: row.secondary_label,
    ghostLabel: row.ghost_label,
    approvedText: row.approved_text,
    dismissedText: row.dismissed_text,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    staleReason: row.stale_reason,
    consumedAt: row.consumed_at === null ? null : row.consumed_at.toISOString(),
    irreversible: row.irreversible === true,
    replayDueAt: row.replay_due_at === null ? null : row.replay_due_at.toISOString(),
    replayClaimedAt:
      row.replay_claimed_at === null ? null : row.replay_claimed_at.toISOString(),
    replayedAt: row.replayed_at === null ? null : row.replayed_at.toISOString(),
    replayAbandonedAt:
      row.replay_abandoned_at === null ? null : row.replay_abandoned_at.toISOString(),
    replayError: row.replay_error,
  };
}
