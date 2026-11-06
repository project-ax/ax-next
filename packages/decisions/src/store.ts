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
import { createHash } from 'node:crypto';
import { MAX_FRAME, SafeToolError, PluginError, type SafeToolCode } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import type { DecisionRow, DecisionsDatabase } from './migrations.js';
import { RECEIPT_STATUSES } from './receipts.js';
import {
  AUTHORISING_STATUSES,
  OPEN_STATUSES,
  type Decision,
  type DecisionStatus,
  type FreshnessPredicate,
  type ToolCall,
  type ToolErrorReplayCode,
} from './types.js';

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

/** What an approval's identical twin did, as far as this store can tell. */
export type TwinOutcome = 'ran' | 'outcome-unknown';

/**
 * `claimForApproval` refused because an identical call this person approved on
 * ANOTHER card — a co-open twin — already went out (TASK-286). `outcome` says
 * how: `'ran'` (the host replayed it, the warm agent took it, or a routine
 * write claimed it) or `'outcome-unknown'` (it was sent and nobody can say
 * whether it landed). Running this one too would make the call twice.
 *
 * Co-open twins come from two routes: an undo (never refused, the TASK-280
 * ruling), and an identical retry the gate stamped BEFORE an approval that it
 * then lands after — `pre-call` stamps `createdAt`, then awaits the
 * attendance and freshness reads before `createOrReuseOpen`, and the first row
 * can be approved in between. Before TASK-286 the second route double-sent
 * too. Do not narrow this rule to restored rows. A twin that has gone out has
 * left the partial unique index, so the index cannot refuse this claim; the
 * store has to.
 *
 * TYPED, for the same two reasons `DuplicateAuthorisationError` is. The plugin
 * speaks a different sentence for this refusal than for the index's, and a
 * different one again for each outcome — so it must be able to tell them
 * apart without guessing from where the throw sits (a catch that turns an
 * exception into prose must test for its cause: TASK-253 F1). And the
 * classification is a question about rows this file owns, so the store
 * answers it in the vocabulary of the decision and no caller reads a column.
 *
 * The row is left exactly as it was: still open, and still answerable.
 */
export class IdenticalCallAlreadyTriedError extends Error {
  /** The twin that already went out — the same owner's row. */
  readonly twinId: string;
  readonly outcome: TwinOutcome;

  constructor(decisionId: string, twinId: string, outcome: TwinOutcome) {
    super(
      outcome === 'ran'
        ? `decision '${decisionId}' was not claimed: its identical twin '${twinId}' already ran`
        : `decision '${decisionId}' was not claimed: its identical twin '${twinId}' was sent with no answer`,
    );
    this.name = 'IdenticalCallAlreadyTriedError';
    this.twinId = twinId;
    this.outcome = outcome;
  }
}

/**
 * Which co-open twin, if any, refuses an approval (TASK-286). The RULE both
 * stores share, so the in-memory fake cannot drift from this one.
 *
 * The caller selects the candidates: this row's agent, owner and call
 * fingerprint, another id, and an answer given at or after this row was
 * raised (`resolved_at >= created_at`; equal instants count). This only
 * classifies them:
 *
 *   * RAN — an authorising status AND `replayed_at` or `consumed_at`: the host
 *     replayed it, the warm agent took it at the gate, or a routine write
 *     claimed it (`claimRoutineAuthority` stamps `consumed_at`).
 *   * OUTCOME UNKNOWN — `failed` AND `replay_abandoned_at`: a reclaimed
 *     stranded flight, or a call sent with no reliable answer, the connector's
 *     `tool-error` code included. It may have landed.
 *
 * NOTHING ELSE REFUSES. A definite failure ran nothing, and its receipt says
 * so, so approving the other card is the honest retry. A dismissed or expired
 * twin never ran. A twin still holding its index slot (deferred, in flight,
 * or authorised and not yet taken) is the index's to refuse, as before.
 *
 * Returns the `ran` twin with the smallest id, else the `outcome-unknown` one
 * with the smallest id, else null: the same answer whatever order the rows
 * arrive in.
 */
export function firstTriedTwin(
  twins: readonly Decision[],
): { twinId: string; outcome: TwinOutcome } | null {
  let ran: string | null = null;
  let unknown: string | null = null;
  for (const twin of twins) {
    if (
      AUTHORISING_STATUSES.includes(twin.status) &&
      (twin.replayedAt !== null || twin.consumedAt !== null)
    ) {
      if (ran === null || twin.id < ran) ran = twin.id;
    } else if (twin.status === 'failed' && twin.replayAbandonedAt !== null) {
      if (unknown === null || twin.id < unknown) unknown = twin.id;
    }
  }
  if (ran !== null) return { twinId: ran, outcome: 'ran' };
  if (unknown !== null) return { twinId: unknown, outcome: 'outcome-unknown' };
  return null;
}

/**
 * Which OPEN row an identical new hold should be folded into, if any
 * (TASK-286). The rule both stores share, beside `firstTriedTwin`.
 *
 * The oldest open row, EXCEPT one whose co-open twin already ran or went out
 * with no answer. That row is the card an undo left behind: approving it is
 * refused for good (`IdenticalCallAlreadyTriedError`), because the twin that
 * ran never changes. Folding the agent's NEXT identical call into it would
 * make that call unapprovable too, until someone dismissed the card or it
 * expired. That next call is asked after the call ran, so it is a new
 * question, and it gets a card it can be answered on. The refused card stays
 * where it is: undo made it, and nothing here closes it (the ruling).
 *
 * ONE WINDOW IT LEAVES, on purpose: while the twin is still in flight it has
 * not gone out yet, so a later hold IS folded into this row, and becomes
 * unapprovable with it if that replay then returns. The next identical call
 * after that gets its own card. Skipping on "in flight" too would raise a
 * second card for a call whose answer is not in yet, which is TASK-254's
 * duplicate.
 *
 * `open` is every open row for the key, oldest first. `answered` is every
 * other row for the key with an answer (`resolvedAt` set). Instants are
 * compared as instants, never as strings.
 */
export function reusableOpenRow(
  open: readonly Decision[],
  answered: readonly Decision[],
): Decision | undefined {
  return open.find((row) => {
    const raisedAt = Date.parse(row.createdAt);
    return (
      firstTriedTwin(
        answered.filter(
          (twin) =>
            twin.id !== row.id &&
            twin.resolvedAt !== null &&
            Date.parse(twin.resolvedAt) >= raisedAt,
        ),
      ) === null
    );
  });
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

/**
 * The advisory-lock key `createOrReuseOpen` and `claimForApproval` serialise
 * on: one lock per (agent, call shape), so two agents holding or approving
 * unrelated calls never wait on each other.
 *
 * Derived in JS rather than with `hashtext(...)` in SQL: that function is an
 * undocumented Postgres internal, so nothing promises its value is stable
 * across server versions — and stability is the whole requirement here. Every
 * host has to compute the same key for the same call, or two replicas mid
 * upgrade are not queueing behind each other at all. A sha256 truncated to a
 * signed 64-bit integer is stable by construction.
 *
 * A collision costs a spurious wait on an unrelated hold or approval and
 * nothing else: the lock only orders the callers, and the SELECT inside it
 * still matches on the real columns. The agent id is folded in for the same
 * reason it is a column — this is the key the standing authorisation is keyed
 * on.
 *
 * Exported for `store.test.ts` only, which holds this lock from a second
 * connection to stop a claim at it; nothing outside this file takes it.
 */
export function openHoldLockKey(agentId: string, callFingerprint: string): string {
  return createHash('sha256')
    .update(`${agentId}\u0000${callFingerprint}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

/** The statuses `restore()` (undo) can walk back from. */
const UNDOABLE_STATUSES: readonly DecisionStatus[] = [...AUTHORISING_STATUSES, 'dismissed'];

export interface DecisionListFilter {
  ownerUserId: string;
  agentId?: string | undefined;
  /** Exact status. Omitted means the open ones. */
  status?: DecisionStatus | undefined;
}

/**
 * How many decisions were raised for this person in a window (TASK-266).
 *
 * A THIRD filter rather than a flag on `DecisionListFilter`, for the same
 * reason the receipt filter is its own: this is a different question with a
 * different answer shape. `list` fetches rows in one exact status; this
 * fetches no rows at all and names no status, and the two things a caller
 * would get wrong by sharing a type — asking for a count and paying for the
 * rows, or asking for a window and quietly getting only the open ones — are
 * exactly the mistakes separate types make unwritable.
 *
 * Note what is NOT here: a status. See `DecisionsCountInput` for why its
 * absence is what makes skipping the expiry sweep on this read correct rather
 * than merely faster.
 */
export interface DecisionCountFilter {
  ownerUserId: string;
  agentId?: string | undefined;
  /** ISO instant, INCLUSIVE — raised at or after it. */
  since: string;
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

  /**
   * RAISE A HOLD, OR HAND BACK THE ONE ALREADY STANDING for this person, this
   * agent and this call shape (TASK-254).
   *
   * `created: false` means the row that comes back is somebody else's write —
   * an OLDER open decision for the identical call — and the caller must adopt
   * its id rather than the one it asked for. The decision it passed in was
   * never written.
   *
   * WHY REUSE RATHER THAN REFUSE. The obvious alternative is a second partial
   * unique index over the open statuses, letting the database refuse the
   * duplicate outright. It cannot be that, because `restore` (undo) moves a
   * row INTO `pending`, and it does so on rows whose identical call may
   * already have been held again: dismiss → the agent tries the same call →
   * undo the dismissal, or an irreversible approval waiting out its undo
   * window → the agent tries again → undo. Both are ordinary sequences, and
   * under such an index both would make `decisions:undo` throw. A hold that
   * fails to raise, or an undo that 500s, is worse than the duplicate either
   * would be preventing.
   *
   * THE KEY IS (agent_id, call_fingerprint) — the same key the standing
   * authorisation is keyed on, because that is the collision being removed:
   * `decisions_v1_authorised_unconsumed` has no conversation in it, so two
   * open rows in two of one person's threads are two cards for ONE
   * authorisation, and approving the second is exactly the refusal this
   * exists to make unreachable.
   *
   * PLUS THE OWNER, which is the one place it is deliberately NARROWER than
   * that index. Reads are owner-scoped; handing user B the id of user A's row
   * on a shared team agent would give B a question they cannot see, answer or
   * dismiss — a question nobody can answer is worse than two that collide. The
   * collision that leaves has two outcomes: refused where nothing has gone out
   * yet (the index), and a SECOND SEND where the host has already replayed and
   * freed the index slot. The `restore` race used to share both; TASK-286's
   * approve-time check (`claimForApproval`) now refuses its second send, but
   * that check is owner-scoped like this collapse, so the two-owner second send
   * remains. Pinned by a test rather than left to be rediscovered.
   *
   * ONE OPEN ROW IS NEVER HANDED BACK (TASK-286): a card whose identical twin
   * already ran or went out with no answer. Approving it is refused for good,
   * so a later identical call folded into it could never be approved either.
   * That call gets a card of its own instead (`reusableOpenRow`).
   *
   * ATOMIC, because the caller's read-then-create is not. Two byte-identical
   * `tool:pre-call` events race in the ordinary course of a turn, and this
   * repo has been bitten by that exact shape before. See the implementation
   * for what the lock does and does not serialise.
   */
  createOrReuseOpen(decision: Decision): Promise<{ decision: Decision; created: boolean }>;
  /** `ownerUserId`, when given, is a scope filter and not a hint. */
  get(decisionId: string, ownerUserId?: string): Promise<Decision | null>;
  list(filter: DecisionListFilter): Promise<Decision[]>;
  recentForConversation(filter: { ownerUserId: string; agentId: string; conversationId: string }): Promise<Decision[]>;

  /**
   * HOW MANY were raised in the window — counted in the database, not fetched
   * and measured here.
   *
   * `list(...).length` is the obvious alternative and it is the wrong one
   * twice over. It cannot express the question at all (list takes one exact
   * status, so "any status" is seven round trips), and even if it could it
   * would drag every matching row across the wire — call inputs, previews,
   * authored sentences — to produce an integer. The row a counter needs is the
   * one it never reads.
   */
  count(filter: DecisionCountFilter): Promise<number>;

  /**
   * The rows a receipt can be derived from, newest resolution first.
   *
   * The filter is `receiptFor`'s rule pushed into SQL — the receipt-bearing
   * statuses, AND an `executed` row only once its call has actually gone out
   * (`replayed_at` for the host, `consumed_at` for the agent) or once nothing
   * on the host side is holding it (no replay due, none in flight — the
   * attended approval waiting at the gate, TASK-517). Doing it here
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
   * IT ALSO THROWS `IdenticalCallAlreadyTriedError` when a co-open twin ran or
   * went out with no answer (TASK-286): an identical row this person approved
   * on another card, answered after this one was raised. Co-open twins come
   * from an undo (never refused) or from a retry the gate stamped before that
   * approval landed (see `IdenticalCallAlreadyTriedError`). Such a twin has left the
   * index, so the index cannot refuse this claim, and the claim is therefore
   * one transaction with a check in front of it. The lock `createOrReuseOpen`
   * takes keeps a second approval from interleaving. `FOR UPDATE` keeps a
   * twin's replay, consume or abandon from landing between the check and the
   * claim. The refused row is left open.
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
   *
   * `deliveryDueAt` (TASK-574) is the attended path's own deferral: when the
   * warm agent gets told. `continuationReqId` rides with it, already
   * validated by the caller. Neither is set on any host path.
   */
  claimForApproval(
    decisionId: string,
    opts: {
      nowIso: string;
      status: 'executed' | 'approved-pending-agent';
      replayDueAt?: string | null;
      replayClaimedAt?: string | null;
      deliveryDueAt?: string | null;
      continuationReqId?: string | null;
      approvalScope?: Decision['approvalScope'];
      consentExpectedRevision?: string | null;
      routineReleaseAt?: string | null;
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
   * The host replay threw (anything but a timeout on a non-routine host tool:
   * a call the bus stopped waiting on may still land, so it goes to
   * `markOutcomeUnknown`, TASK-285).
   * Records the failure and DROPS the standing authorisation with it (the
   * partial index does not cover `failed`), because an action that did not
   * happen must not leave behind a yes the agent can quietly cash in later.
   */
  markFailed(
    decisionId: string,
    opts: { error: string | null; failureCode?: SafeToolCode },
  ): Promise<Decision | null>;

  /**
   * The host SENT the call and got no reliable answer: a connector call that
   * timed out, lost its connection, or came back unreadable (TASK-1046), or a
   * host tool call the bus stopped waiting on (TASK-285; the bus's timeout does
   * not stop the tool). It may or may not have happened.
   *
   * `failed` + `replay_abandoned_at`, the shape `reclaimStrandedFlights`
   * writes, because to a reader it means the same thing: no report, so
   * `receiptFor` says we cannot tell (`ABANDONED_RECEIPT`) and never "Nothing
   * was completed". Like `markFailed` it drops the standing authorisation (the
   * partial index does not cover `failed`), so the yes is spent and a later
   * identical call holds again. `replay_error` is cleared — nobody reported
   * anything, so there is no detail to carry — and `resolved_at` is untouched.
   *
   * Reachable only from `executed`. A null return means the row moved first (a
   * reclaim, a returning `markReplayed`), and whoever moved it owns what it
   * says.
   *
   * `code` (review F3): `TOOL_ERROR_REPLAY_CODE` when the connector's service
   * answered that the call did not work (the tool may have run). It is written to `replay_error` in
   * place of null, the one closed code an abandoned row may carry, so the
   * receipt can say the service said no rather than "interrupted".
   */
  markOutcomeUnknown(
    decisionId: string,
    nowIso: string,
    code?: ToolErrorReplayCode | null,
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
   * Claim every deferred DELIVERY whose undo window has closed (TASK-574) —
   * the attended twin of `claimDueReplays`, and one-shot the same way: the
   * claiming UPDATE clears `delivery_due_at` and stamps `delivered_at` with
   * both as predicates, so a second replica gets nothing back.
   *
   * `delivered_at` is ALSO what closes the row to `restore`. That is the race
   * this whole column exists for: an Undo and the claim landing together at
   * the window's edge. Postgres serialises the two single-row UPDATEs; whichever
   * commits first wins and the other matches nothing — so either the agent is
   * told and the Undo is refused, or the Undo lands and nothing is ever told.
   * Never both.
   *
   * A row the agent has already CONSUMED is not claimed (`takeApproval` clears
   * its due-time anyway): it took the approval up on its own, and telling it
   * again would prompt a second call that meets no authorisation.
   *
   * A host that dies between the claim and the delivery loses the delivery.
   * The row is left `executed` and unconsumed: the standing authorisation is
   * still at the gate for the agent's next run, and the receipt says so.
   */
  claimDueDeliveries(
    nowIso: string,
    limit: number,
  ): Promise<Array<{ decision: Decision; continuationReqId: string | null }>>;

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
   * braces. `HookBus` bounds every service call at its ceiling (120 s by
   * default, and no tool executor here registers a longer one), so a host
   * replay older than a cutoff comfortably past about 240 s (a connector
   * replay is two calls in a row) is no longer inside its `bus.call` in any
   * host. A ROUTINE replay is the exception: it runs through `callJoined`,
   * which waits for every nested call with no ceiling, so the bound does not
   * hold for it — and the reclaim stays safe all the same, because it runs
   * nothing. See `STRANDED_REPLAY_TIMEOUT_MS`.
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
  takeApproval(agentId: string, callFingerprint: string, nowIso: string): Promise<Decision | null>;

  /**
   * DELETE EVERY DECISION FOR AN AGENT, whatever its status and whoever owns it
   * (TASK-718). Backs the `agents:deleted` subscriber: `agent_id` is an opaque
   * key with no FK to the agents table, so without this the rows outlive the
   * agent forever.
   *
   * The one method here that is deliberately NOT owner-scoped. A team agent
   * raises holds for several people, and a delete scoped to one owner would
   * strand the rest. Terminal rows go too: with the agent gone there is nobody
   * left for a receipt to be filed under, and a decision's `call_json` is the
   * model's own words, held verbatim.
   *
   * THROWS on an empty `agentId`: a delete keyed on nothing is never what a
   * caller meant, so it is refused rather than run.
   */
  findRoutineApproval(
    agentId: string,
    userId: string,
    fingerprint: string,
    nowIso: string,
  ): Promise<Decision | null>;
  hasRoutineAuthority(input: { agentId: string; userId: string; requestId: string; fingerprint: string; nowIso: string }): Promise<boolean>;
  rejectUnstartedRoutineCall(input: { agentId: string; userId: string; requestId: string; fingerprint: string; failureCode: SafeToolCode; nowIso: string }): Promise<boolean>;
  claimRoutineAuthority(input: {
    agentId: string;
    userId: string;
    fingerprint: string;
    requestId: string;
    authorizationId: string;
    nowIso: string;
    expiresAt: string;
    consent: boolean;
  }): Promise<{ authorizationId: string; requestId: string; outcome: null | 'succeeded' }>;
  settleRoutineAuthority(input: {
    agentId: string;
    userId: string;
    authorizationId: string;
    requestId: string;
    fingerprint: string;
    outcome: 'succeeded' | 'failed';
    failureCode: SafeToolCode | null;
    nowIso: string;
  }): Promise<void>;
  claimRoutineConsent(nowIso: string, limit: number): Promise<Decision[]>;
  finishRoutineConsent(
    decisionId: string,
    state: 'delivered' | 'failed',
    granted: boolean,
  ): Promise<void>;
  recoverRoutineReplays(nowIso: string, claimedBeforeIso: string): Promise<void>;
  deleteAllForAgent(agentId: string): Promise<{ deleted: number }>;
}

export function createDecisionsStore(db: Kysely<DecisionsDatabase>): DecisionStore {
  const table = 'decisions_v1_decisions' as const;

  /** `on` is `db`, or the transaction a caller is already inside. */
  async function transition(
    on: Kysely<DecisionsDatabase>,
    decisionId: string,
    from: readonly DecisionStatus[],
    set: Partial<DecisionRow>,
  ): Promise<Decision | null> {
    const row = await on
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
    on: Kysely<DecisionsDatabase>,
    decisionId: string,
    opts: {
      nowIso: string;
      status: 'executed' | 'approved-pending-agent';
      replayDueAt?: string | null | undefined;
      replayClaimedAt?: string | null | undefined;
      deliveryDueAt?: string | null | undefined;
      continuationReqId?: string | null | undefined;
      approvalScope?: Decision['approvalScope'];
      consentExpectedRevision?: string | null;
      routineReleaseAt?: string | null;
    },
  ): Promise<Decision | null> {
    const { nowIso, status, replayDueAt, replayClaimedAt, deliveryDueAt, continuationReqId } = opts;
    return transition(on, decisionId, OPEN_STATUSES, {
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
      // TASK-574. The attended deferral, written in the same statement as the
      // claim so there is no instant at which the row is `executed` with its
      // delivery neither scheduled nor done. `delivered_at` restarts with it:
      // this is a new approval, and nothing has been told about it yet.
      delivery_due_at:
        deliveryDueAt === undefined || deliveryDueAt === null ? null : new Date(deliveryDueAt),
      delivery_req_id:
        continuationReqId === undefined || continuationReqId === null ? null : continuationReqId,
      delivered_at: null,
      approval_scope: opts.approvalScope ?? 'once',
      consent_expected_revision: opts.consentExpectedRevision ?? null,
      consent_delivery_state: opts.approvalScope === 'agent-routines' ? 'pending' : 'none',
      routine_release_at: opts.routineReleaseAt ? new Date(opts.routineReleaseAt) : null,
    });
  }

  return {
    async create(decision) {
      await db.insertInto(table).values(fromDecision(decision)).execute();
      return decision;
    },

    async createOrReuseOpen(decision) {
      return db.transaction().execute(async (trx) => {
        // THE SERIALISER. Without it this is a textbook TOCTOU: under READ
        // COMMITTED neither of two concurrent transactions sees the other's
        // uncommitted row, so both read "nothing open" and both insert. That
        // is not theoretical — with a warm connection pool, eight racing holds
        // of one call produced eight rows on every run before this line
        // existed. `store.test.ts` pins it, and warms the pool on purpose: a
        // pool still opening its connections serialises the callers by
        // accident, and that accident is what made the first cut of that test
        // pass with no guard here at all.
        //
        // An advisory lock rather than a unique index because the index is the
        // option this method exists to avoid — see the doc on the interface:
        // it would make `restore` throw on ordinary undo sequences. The lock
        // constrains only the callers that take it, which is the trade being
        // made deliberately.
        //
        // WHAT IT DOES NOT COVER. `restore` (undo) walks a row back into
        // `pending` without consulting the open row an agent's retry raised in
        // the meantime, so dismiss → the agent tries the identical call → undo
        // still leaves TWO open rows for one call shape. The gate never sees
        // that pair: both rows already existed when the undo landed. That is
        // allowed on purpose — Undo is a grace period and is never refused for
        // a new reason (the TASK-280 ruling, upheld for TASK-286).
        //
        // What stops the pair from running the call twice sits at the point of
        // consequence instead: `claimForApproval` takes THIS lock too, and
        // refuses an approval whose identical twin — answered after this row
        // was raised — already ran or went out with no answer
        // (`IdenticalCallAlreadyTriedError`). Before that check the reversible
        // unattended path sent the call a second time: `markReplayed` stamps
        // `replayed_at`, which is in the index's own predicate, so the second
        // claim found the slot free. So did an attended or parked pair once the
        // agent had taken the first yes. `decisions.canary.test.ts` pins the
        // refusal by the executor's invocation count.
        //
        // TAKING THIS LOCK IN `restore` WOULD NOT HAVE CLOSED IT, and still
        // would not. The two writes touch DIFFERENT rows: `restore` never asks
        // whether a colliding open row exists, and after it returns both rows
        // are `pending` however the two were ordered.
        //
        // It is held for the two statements below and released by COMMIT or
        // ROLLBACK whatever happens — the transaction-scoped variant cannot be
        // leaked by a caller that forgets to unlock, which the session-scoped
        // one can.
        await sql`SELECT pg_advisory_xact_lock(${openHoldLockKey(
          decision.agentId,
          decision.callFingerprint,
        )}::bigint)`.execute(trx);

        const open = (
          await trx
            .selectFrom(table)
            .selectAll()
            .where('agent_id', '=', decision.agentId)
            .where('owner_user_id', '=', decision.ownerUserId)
            .where('call_fingerprint', '=', decision.callFingerprint)
            .where('status', 'in', OPEN_STATUSES as string[])
            .orderBy('created_at', 'asc')
            .orderBy('decision_id', 'asc')
            .execute()
        ).map(toDecision);
        // TASK-286: skip an open row whose twin already went out — see
        // `reusableOpenRow`. Its possible twins were answered at or after the
        // oldest open row was raised, so that bounds the read; nearly always
        // there is one open row and this finds nothing.
        const oldest = open[0];
        const answered =
          oldest === undefined
            ? []
            : (
                await trx
                  .selectFrom(table)
                  .selectAll()
                  .where('agent_id', '=', decision.agentId)
                  .where('owner_user_id', '=', decision.ownerUserId)
                  .where('call_fingerprint', '=', decision.callFingerprint)
                  .where('resolved_at', '>=', new Date(oldest.createdAt))
                  .execute()
              ).map(toDecision);
        const existing = reusableOpenRow(open, answered);
        if (existing !== undefined) {
          return { decision: existing, created: false };
        }
        await trx.insertInto(table).values(fromDecision(decision)).execute();
        return { decision, created: true };
      });
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

    async recentForConversation({ ownerUserId, agentId, conversationId }) {
      const rows = await db.selectFrom(table).selectAll()
        .where('owner_user_id', '=', ownerUserId).where('agent_id', '=', agentId)
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at', 'desc').orderBy('decision_id', 'desc').limit(100).execute();
      return rows.map(toDecision);
    },

    async count({ ownerUserId, agentId, since }) {
      let q = db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as('n'))
        .where('owner_user_id', '=', ownerUserId)
        // WHEN IT WAS RAISED, not when it was answered. The counter's sentence
        // is about the agent stopping to ask, and plenty of the rows it counts
        // were never answered — an expired one has a `resolved_at` written by
        // a sweep, which is a fact about the clock rather than about the
        // person, and a pending one has none.
        .where('created_at', '>=', new Date(since));
      if (agentId !== undefined) q = q.where('agent_id', '=', agentId);
      const row = await q.executeTakeFirstOrThrow();
      // `count(*)` is a bigint, and node-postgres hands bigints back as
      // STRINGS to avoid losing precision it cannot represent. `Number` of that
      // string is the conversion; a row count that overflows a double is not a
      // thing this table can reach.
      return Number(row.n);
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
        // the moment a human says yes, and on some paths the call has not gone
        // out yet. The HOST's two — an irreversible call waiting out its undo
        // window (`replay_due_at`), a replay in flight (`replay_claimed_at`) —
        // have nothing to report yet. An attended approval waiting for its
        // warm agent has neither marker, and DOES: its yes is banked at the
        // gate, and `receiptFor` says so (TASK-517).
        .where((eb) =>
          eb.or([
            eb('status', '!=', 'executed'),
            eb('replayed_at', 'is not', null),
            eb('consumed_at', 'is not', null),
            eb.and([eb('replay_due_at', 'is', null), eb('replay_claimed_at', 'is', null)]),
          ]),
        )
        .orderBy('resolved_at', 'desc')
        .orderBy('decision_id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toDecision);
    },

    async claimForApproval(decisionId, opts) {
      try {
        return await db.transaction().execute(async (trx) => {
          // THIS ROW FIRST. Its agent and call shape are the lock key, and a
          // row that is no longer open answers with the same "someone else
          // resolved it" null as ever, never with the twin refusal below over
          // a card another tab already answered.
          const self = await trx
            .selectFrom(table)
            .select(['agent_id', 'owner_user_id', 'call_fingerprint', 'created_at', 'status'])
            .where('decision_id', '=', decisionId)
            .executeTakeFirst();
          if (self === undefined || !(OPEN_STATUSES as readonly string[]).includes(self.status)) {
            return null;
          }

          // THE LOCK `createOrReuseOpen` TAKES, and it stops approve against
          // approve. While a twin is still PENDING it has no `resolved_at`, so
          // the read below does not match it and `FOR UPDATE` has nothing to
          // hold. Without this, two approvals of a co-open pair can each check
          // while the other is still open; one is then claimed, replayed and
          // out of the index before the other's UPDATE reaches it, the slot is
          // free, and the call goes out twice.
          await sql`SELECT pg_advisory_xact_lock(${openHoldLockKey(
            self.agent_id,
            self.call_fingerprint,
          )}::bigint)`.execute(trx);

          // AND THIS ROW AGAIN, now under the lock and held. The read above
          // was only for the key: a dismiss in another tab or the expiry sweep
          // can close the row while this approval waits for the lock, and the
          // answer for that is the same null, not the twin refusal below about
          // a card that was already answered another way. `FOR UPDATE` keeps
          // it open until the claim lands, so the two cannot disagree.
          const stillOpen = await trx
            .selectFrom(table)
            .select('status')
            .where('decision_id', '=', decisionId)
            .forUpdate()
            .executeTakeFirst();
          if (
            stillOpen === undefined ||
            !(OPEN_STATUSES as readonly string[]).includes(stillOpen.status)
          ) {
            return null;
          }

          // THE TWINS, held until this claim commits. A twin's replay
          // returning (`markReplayed`), the agent taking it (`takeApproval`)
          // and an abandon (`markOutcomeUnknown`, the stranded-flight reclaim)
          // never take the lock above; `FOR UPDATE` is what keeps them from
          // landing between this check and the claim, taking the twin out of
          // the index the claim is counting on. Locked in id order, so the
          // order is deterministic. Two multi-row writers lock these rows in
          // other orders — `claimRoutineAuthority` (newest first) and
          // `recoverRoutineReplays` — so two undo-made ROUTINE twins can
          // deadlock against them in principle. That surfaces as a `40P01`
          // fault the approver sees, never as a silent second send.
          //
          // Not one `UPDATE ... WHERE NOT EXISTS`: that reads the twins from
          // the statement's snapshot while the unique check sees the current
          // state, so a replay committing in between leaves the slot free.
          const twins = await trx
            .selectFrom(table)
            .selectAll()
            .where('agent_id', '=', self.agent_id)
            .where('owner_user_id', '=', self.owner_user_id)
            .where('call_fingerprint', '=', self.call_fingerprint)
            .where('decision_id', '<>', decisionId)
            // Answered at or after this question was raised. Two rows are
            // co-open only after an undo, or when a retry was stamped before
            // an approval that landed first (see the error's doc). A later ask
            // is raised after the answer it follows, so it is never refused.
            .where('resolved_at', '>=', self.created_at)
            .orderBy('decision_id')
            .forUpdate()
            .execute();
          const tried = firstTriedTwin(twins.map(toDecision));
          if (tried !== null) {
            throw new IdenticalCallAlreadyTriedError(decisionId, tried.twinId, tried.outcome);
          }

          // A twin that has NOT gone out still holds its index slot, and the
          // index refuses this claim exactly as before (`23505`, below).
          return claim(trx, decisionId, opts);
        });
      } catch (err) {
        // Translate ONLY the index's refusal. `throw err` for everything else
        // is not a fallthrough — it is the branch that keeps a transient write
        // failure from being reported as a standing authorisation. (The twin
        // refusal above is already typed, and leaves as itself.)
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
      return transition(db, decisionId, ['executed'], {
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

    markFailed(decisionId, { error, failureCode }) {
      return transition(db, decisionId, ['executed'], {
        status: 'failed',
        replay_error: error,
        ...(failureCode
          ? {
              routine_failure_code: failureCode,
              routine_failure_field: 'input',
              routine_outcome: 'failed',
            }
          : {}),
        replay_due_at: null,
      });
    },

    markOutcomeUnknown(decisionId, nowIso, code = null) {
      return transition(db, decisionId, ['executed'], {
        status: 'failed',
        replay_abandoned_at: new Date(nowIso),
        replay_error: code,
        replay_due_at: null,
      });
    },

    markDismissed(decisionId, nowIso) {
      return transition(db, decisionId, OPEN_STATUSES, {
        status: 'dismissed',
        resolved_at: new Date(nowIso),
      });
    },

    markStale(decisionId, { staleReason, freshness }) {
      return transition(db, decisionId, OPEN_STATUSES, {
        status: 'stale',
        stale_reason: staleReason,
        freshness_json: freshness === null ? null : JSON.stringify(freshness),
        resolved_at: null,
      });
    },

    markExpired(decisionId, nowIso) {
      return transition(db, decisionId, OPEN_STATUSES, {
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
          // TASK-574 — and cancels the deferred hand-over to the warm agent the
          // same way, which is what makes an Undo inside the window clean: the
          // agent never hears about a yes that was taken back, so it never
          // re-issues a call that would be held a second time.
          delivery_due_at: null,
          delivery_req_id: null,
          approval_scope: 'once',
          consent_expected_revision: null,
          consent_delivery_state: 'none',
          consent_granted: null,
          routine_release_at: null,
        })
        .where('decision_id', '=', decisionId)
        .where('status', 'in', UNDOABLE_STATUSES as string[])
        .where('consumed_at', 'is', null)
        .where('consent_delivery_claimed_at', 'is', null)
        .where('routine_authorization_id', 'is', null)
        // Nor once the warm agent has been TOLD. The resolution is on its
        // inbox and no Undo can recall it; reopening the row would leave the
        // agent's re-issued call to meet a pending question and be held again
        // — the duplicate "held again" reply TASK-574 exists to remove.
        .where('delivered_at', 'is', null)
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
        .where('consent_delivery_state', 'not in', ['pending', 'failed'])
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
        .where('consent_delivery_state', 'not in', ['pending', 'failed'])
        .where('replay_due_at', 'is not', null)
        .where('replay_claimed_at', 'is', null)
        .returningAll()
        .execute();
      return rows.map(toDecision);
    },

    async claimDueDeliveries(nowIso, limit) {
      const due = await db
        .selectFrom(table)
        .select('decision_id')
        .where('status', '=', 'executed')
        .where('consent_delivery_state', 'not in', ['pending', 'failed'])
        .where('delivery_due_at', 'is not', null)
        .where('delivery_due_at', '<=', new Date(nowIso))
        .where('consumed_at', 'is', null)
        .orderBy('delivery_due_at', 'asc')
        .limit(limit)
        .execute();
      if (due.length === 0) return [];

      // The claim, restating every predicate: between the read above and this
      // write an Undo, a consuming agent or another replica's sweep may have
      // moved the row, and whoever did owns what it says.
      const rows = await db
        .updateTable(table)
        .set({ delivery_due_at: null, delivered_at: new Date(nowIso) })
        .where(
          'decision_id',
          'in',
          due.map((d) => d.decision_id),
        )
        .where('status', '=', 'executed')
        .where('consent_delivery_state', 'not in', ['pending', 'failed'])
        .where('delivery_due_at', 'is not', null)
        .where('delivery_due_at', '<=', new Date(nowIso))
        .where('consumed_at', 'is', null)
        .returningAll()
        .execute();
      return rows.map((row) => ({
        decision: toDecision(row),
        continuationReqId: row.delivery_req_id,
      }));
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
        .where('routine_release_at', 'is', null)
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
        .where('routine_release_at', 'is', null)
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
        // TASK-574: an agent that took the approval up on its own (a message
        // woke it inside the undo window) needs no hand-over any more — and
        // one arriving afterwards would prompt a second call that meets no
        // authorisation and is held again. Cleared in the consuming statement.
        .set({ consumed_at: new Date(nowIso), delivery_due_at: null })
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

    async findRoutineApproval(agentId, userId, fingerprint, nowIso) {
      const row = await db
        .selectFrom(table)
        .selectAll()
        .where('agent_id', '=', agentId)
        .where('owner_user_id', '=', userId)
        .where('call_fingerprint', '=', fingerprint)
        .where('status', 'in', AUTHORISING_STATUSES as string[])
        .where('expires_at', '>', new Date(nowIso))
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row ? toDecision(row) : null;
    },
    async hasRoutineAuthority(input) {
      const row = await db.selectFrom('decisions_v1_routine_authorizations')
        .select('authorization_id')
        .where('agent_id', '=', input.agentId).where('user_id', '=', input.userId)
        .where('request_id', '=', input.requestId).where('fingerprint', '=', input.fingerprint)
        .where('expires_at', '>', new Date(input.nowIso))
        .where(eb => eb.or([eb('outcome', 'is', null), eb('outcome', '=', 'succeeded')]))
        .executeTakeFirst();
      return row !== undefined;
    },
    async rejectUnstartedRoutineCall(input) {
      return db.transaction().execute(async trx => {
        await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${input.agentId},18427151))`.execute(trx);
        // The same lock as claimRoutineAuthority: no executor can start between
        // proving that no authority exists and recording the preflight refusal.
        await sql`SELECT pg_advisory_xact_lock(${openHoldLockKey(input.agentId, input.userId + ':' + input.requestId)}::bigint)`.execute(trx);
        const started = await trx.selectFrom('decisions_v1_routine_authorizations').select('authorization_id')
          .where('agent_id', '=', input.agentId).where('user_id', '=', input.userId)
          .where('request_id', '=', input.requestId).executeTakeFirst();
        if (started) return false; // A pending or completed effect must use its existing settlement path.
        const rows = await trx.updateTable(table).set({ status: 'failed', routine_outcome: 'failed',
          routine_failure_code: input.failureCode, routine_failure_field: 'input', replay_due_at: null,
          delivery_due_at: null, replay_abandoned_at: null, replay_error: null })
          .where('agent_id', '=', input.agentId).where('owner_user_id', '=', input.userId)
          .where('call_fingerprint', '=', input.fingerprint).where('status', 'in', AUTHORISING_STATUSES as string[])
          .where('routine_authorization_id', 'is', null).where('routine_outcome', 'is', null)
          .where('routine_release_at', '<=', new Date(input.nowIso))
          .where('consent_delivery_state', 'not in', ['pending', 'failed'])
          .returning('decision_id').execute();
        return rows.length > 0;
      });
    },
    async claimRoutineAuthority(input) {
      return db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${input.agentId},18427151))`.execute(
          trx,
        );
        const retired = await trx
          .selectFrom('decisions_v1_routine_retired_agents')
          .select('agent_id')
          .where('agent_id', '=', input.agentId)
          .executeTakeFirst();
        if (retired) throw new SafeToolError('not-found', 'input');
        await sql`SELECT pg_advisory_xact_lock(${openHoldLockKey(input.agentId, input.userId + ':' + input.requestId)}::bigint)`.execute(
          trx,
        );
        const previous = await trx
          .selectFrom('decisions_v1_routine_authorizations')
          .selectAll()
          .where('agent_id', '=', input.agentId)
          .where('user_id', '=', input.userId)
          .where('request_id', '=', input.requestId)
          .executeTakeFirst();
        if (previous) {
          if (previous.fingerprint !== input.fingerprint)
            throw new SafeToolError('request-conflict', 'requestId');
          if (previous.outcome === 'failed')
            throw new SafeToolError(
              (previous.failure_code ?? 'unavailable') as SafeToolCode,
              'input',
            );
          if (previous.expires_at <= new Date(input.nowIso))
            throw new SafeToolError('approval-required', 'input');
          return { authorizationId: previous.authorization_id, requestId: previous.request_id, outcome: previous.outcome === 'succeeded' ? 'succeeded' as const : null };
        }
        const decision = await trx
          .selectFrom(table)
          .selectAll()
          .where('agent_id', '=', input.agentId)
          .where('owner_user_id', '=', input.userId)
          .where('call_fingerprint', '=', input.fingerprint)
          .where('status', 'in', [...AUTHORISING_STATUSES, 'expired', 'failed'] as string[])
          .where('routine_release_at', 'is not', null)
          .where('routine_authorization_id', 'is', null)
          .orderBy('created_at', 'desc')
          .forUpdate()
          .executeTakeFirst();
        if (
          decision &&
          (!AUTHORISING_STATUSES.includes(decision.status as DecisionStatus) ||
            decision.routine_release_at === null ||
            decision.routine_release_at > new Date(input.nowIso) ||
            decision.expires_at <= new Date(input.nowIso) ||
            ['pending', 'failed'].includes(decision.consent_delivery_state))
        ) {
          throw new SafeToolError('approval-required', 'input');
        }
        if (!decision && !input.consent) throw new SafeToolError('approval-required', 'input');
        await trx
          .insertInto('decisions_v1_routine_authorizations')
          .values({
            authorization_id: input.authorizationId,
            agent_id: input.agentId,
            user_id: input.userId,
            request_id: input.requestId,
            fingerprint: input.fingerprint,
            decision_id: decision?.decision_id ?? null,
            expires_at: decision?.expires_at ?? new Date(input.expiresAt),
            created_at: new Date(input.nowIso),
            outcome: null,
            failure_code: null,
          })
          .execute();
        if (decision)
          await trx
            .updateTable(table)
            .set({
              routine_authorization_id: input.authorizationId,
              routine_execution_fingerprint: input.fingerprint,
              consumed_at: new Date(input.nowIso),
            })
            .where('decision_id', '=', decision.decision_id)
            .execute();
        return { authorizationId: input.authorizationId, requestId: input.requestId, outcome: null };
      });
    },
    async settleRoutineAuthority(input) {
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('decisions_v1_routine_authorizations')
          .selectAll()
          .where('authorization_id', '=', input.authorizationId)
          .where('agent_id', '=', input.agentId)
          .where('user_id', '=', input.userId)
          .where('request_id', '=', input.requestId)
          .where('fingerprint', '=', input.fingerprint)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new SafeToolError('forbidden', 'input');
        if (row.outcome !== null) {
          if (row.outcome !== input.outcome)
            throw new SafeToolError('request-conflict', 'requestId');
          return;
        }
        await trx
          .updateTable('decisions_v1_routine_authorizations')
          .set({ outcome: input.outcome, failure_code: input.failureCode })
          .where('authorization_id', '=', input.authorizationId)
          .execute();
        if (row.decision_id)
          await trx
            .updateTable(table)
            .set({
              routine_outcome: input.outcome,
              routine_failure_code: input.failureCode,
              routine_failure_field: input.failureCode ? 'input' : null,
              status: input.outcome === 'failed' ? 'failed' : 'executed',
              replay_due_at: null,
              delivery_due_at: null,
              replay_abandoned_at: null,
              replay_error: null,
            })
            .where('decision_id', '=', row.decision_id)
            .execute();
      });
    },
    async claimRoutineConsent(nowIso, limit) {
      // The first claim must precede expiry. A persisted claim means permission delivery
      // was accepted before expiry; its idempotent acknowledgement may be recovered later.
      // This does not extend the separate execution authorization's expiry.
      return db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom(table)
          .selectAll()
          .where('status', 'in', AUTHORISING_STATUSES as string[])
          .where('approval_scope', '=', 'agent-routines')
          .where('consent_delivery_state', '=', 'pending')
          .where('routine_release_at', '<=', new Date(nowIso))
          .where((eb) =>
            eb.or([
              eb('expires_at', '>', new Date(nowIso)),
              eb('consent_delivery_claimed_at', 'is not', null),
            ]),
          )
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        if (rows.length)
          await trx
            .updateTable(table)
            .set({
              consent_delivery_claimed_at: sql`COALESCE(consent_delivery_claimed_at, ${new Date(nowIso)})`,
            })
            .where(
              'decision_id',
              'in',
              rows.map((r) => r.decision_id),
            )
            .execute();
        return rows.map(toDecision);
      });
    },
    async finishRoutineConsent(decisionId, state, granted) {
      await db
        .updateTable(table)
        .set({
          consent_delivery_state: state,
          consent_granted: granted,
          ...(state === 'failed'
            ? {
                status: 'failed',
                routine_outcome: 'failed',
                routine_failure_code: 'approval-required',
                routine_failure_field: 'input',
                replay_due_at: null,
                delivery_due_at: null,
              }
            : {}),
        })
        .where('decision_id', '=', decisionId)
        .where('consent_delivery_state', '=', 'pending')
        .execute();
    },
    async recoverRoutineReplays(nowIso, claimedBeforeIso) {
      // Expired unsent consent never acquires a grant after its decision lifetime.
      await db
        .updateTable(table)
        .set({
          status: 'expired',
          consent_delivery_state: 'failed',
          consent_granted: false,
          replay_due_at: null,
          delivery_due_at: null,
        })
        .where('status', 'in', AUTHORISING_STATUSES as string[])
        .where('consent_delivery_state', '=', 'pending')
        .where('consent_delivery_claimed_at', 'is', null)
        .where('expires_at', '<=', new Date(nowIso))
        .execute();
      // A host may die after claiming delivery but before the warm runner hears.
      await db
        .updateTable(table)
        .set({ delivery_due_at: new Date(nowIso) })
        .where('status', '=', 'executed')
        .where('routine_release_at', 'is not', null)
        .where('routine_outcome', 'is', null)
        .where('consumed_at', 'is', null)
        .where('delivery_due_at', 'is', null)
        .where('replay_claimed_at', 'is', null)
        .where('delivered_at', '<=', new Date(claimedBeforeIso))
        .execute();
      await db
        .updateTable(table)
        .set({ replay_due_at: new Date(nowIso), replay_claimed_at: null })
        .where('status', '=', 'executed')
        .where('routine_release_at', 'is not', null)
        .where('routine_outcome', 'is', null)
        .where('replayed_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('replay_claimed_at', '<=', new Date(claimedBeforeIso)),
            // Attended execution claims authority at the host boundary without a
            // host replay stamp. Recover that same recorded request if its caller died.
            eb.and([
              eb('replay_claimed_at', 'is', null),
              eb('routine_authorization_id', 'is not', null),
              eb('consumed_at', '<=', new Date(claimedBeforeIso)),
            ]),
          ]),
        )
        .execute();
    },
    async deleteAllForAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new PluginError({
          code: 'missing-field',
          plugin: '@ax/decisions',
          message: 'agentId is required',
        });
      }
      return db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${agentId},18427151))`.execute(trx);
        await trx
          .insertInto('decisions_v1_routine_retired_agents')
          .values({ agent_id: agentId })
          .onConflict((oc) => oc.column('agent_id').doNothing())
          .execute();
        await trx
          .deleteFrom('decisions_v1_routine_authorizations')
          .where('agent_id', '=', agentId)
          .execute();
        const res = await trx.deleteFrom(table).where('agent_id', '=', agentId).executeTakeFirst();
        return { deleted: Number(res.numDeletedRows ?? 0n) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function fromDecision(d: Decision): DecisionRow {
  // Approval must retain the exact call. Refuse oversized new writes rather
  // than storing a truncated call that could approve different arguments.
  const callJson = JSON.stringify(d.call);
  if (Buffer.byteLength(callJson) > MAX_FRAME) {
    throw new PluginError({ code: 'invalid-payload', plugin: '@ax/decisions', message: 'The tool call is too large to save for approval.' });
  }
  return {
    decision_id: d.id,
    agent_id: d.agentId,
    owner_user_id: d.ownerUserId,
    conversation_id: d.conversationId,
    kind: d.kind,
    attendance: d.attendance,
    status: d.status,
    call_json: callJson,
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
    replay_claimed_at: d.replayClaimedAt === null ? null : new Date(d.replayClaimedAt),
    replayed_at: d.replayedAt === null ? null : new Date(d.replayedAt),
    replay_abandoned_at: d.replayAbandonedAt === null ? null : new Date(d.replayAbandonedAt),
    replay_error: d.replayError,
    delivery_due_at: d.deliveryDueAt === null ? null : new Date(d.deliveryDueAt),
    // Never on `Decision`: it is chat correlation, not decision state. Only
    // `claimForApproval` writes it.
    delivery_req_id: null,
    delivered_at: d.deliveredAt === null ? null : new Date(d.deliveredAt),
    approval_scope: d.approvalScope,
    consent_expected_revision: d.consentExpectedRevision,
    consent_delivery_state: d.consentDeliveryState,
    consent_granted: d.consentGranted,
    consent_delivery_claimed_at:
      d.consentDeliveryClaimedAt === null ? null : new Date(d.consentDeliveryClaimedAt),
    routine_release_at: d.routineReleaseAt === null ? null : new Date(d.routineReleaseAt),
    routine_authorization_id: d.routineAuthorizationId,
    routine_execution_fingerprint: d.routineExecutionFingerprint,
    routine_outcome: d.routineOutcome,
    routine_failure_code: d.routineFailureCode,
    routine_failure_field: d.routineFailureField,
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
      row.freshness_json === null ? null : (JSON.parse(row.freshness_json) as FreshnessPredicate),
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
    replayClaimedAt: row.replay_claimed_at === null ? null : row.replay_claimed_at.toISOString(),
    replayedAt: row.replayed_at === null ? null : row.replayed_at.toISOString(),
    replayAbandonedAt:
      row.replay_abandoned_at === null ? null : row.replay_abandoned_at.toISOString(),
    replayError: row.replay_error,
    deliveryDueAt: row.delivery_due_at === null ? null : row.delivery_due_at.toISOString(),
    deliveredAt: row.delivered_at === null ? null : row.delivered_at.toISOString(),
    approvalScope: row.approval_scope as Decision['approvalScope'],
    consentExpectedRevision: row.consent_expected_revision as Decision['consentExpectedRevision'],
    consentDeliveryState: row.consent_delivery_state as Decision['consentDeliveryState'],
    consentGranted: row.consent_granted as Decision['consentGranted'],
    consentDeliveryClaimedAt:
      row.consent_delivery_claimed_at === null
        ? null
        : row.consent_delivery_claimed_at.toISOString(),
    routineReleaseAt: row.routine_release_at === null ? null : row.routine_release_at.toISOString(),
    routineAuthorizationId: row.routine_authorization_id as Decision['routineAuthorizationId'],
    routineExecutionFingerprint:
      row.routine_execution_fingerprint as Decision['routineExecutionFingerprint'],
    routineOutcome: row.routine_outcome as Decision['routineOutcome'],
    routineFailureCode: row.routine_failure_code as Decision['routineFailureCode'],
    routineFailureField: row.routine_failure_field as Decision['routineFailureField'],
  };
}
