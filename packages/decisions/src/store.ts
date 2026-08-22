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
import {
  AUTHORISING_STATUSES,
  type Decision,
  type DecisionStatus,
  type FreshnessPredicate,
  type ToolCall,
} from './types.js';

/** The two statuses a human can still act on. */
const OPEN_STATUSES: readonly DecisionStatus[] = ['pending', 'stale'];

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

export interface DecisionStore {
  create(decision: Decision): Promise<Decision>;
  /** `ownerUserId`, when given, is a scope filter and not a hint. */
  get(decisionId: string, ownerUserId?: string): Promise<Decision | null>;
  list(filter: DecisionListFilter): Promise<Decision[]>;

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
   * this throws if one already exists for this (agent, call fingerprint).
   * Refusing loudly is the point.
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
   * world and the row has to agree with it — including when an undo landed in
   * the microseconds between the executor returning and this write. The undo
   * lost; the send happened. Same rule `consumed_at` already enforces: that
   * bell cannot be un-rung. Returns `null` only when the row is gone entirely.
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
   * replay loses the replay. The row stays `executed` with no receipt, which
   * reads as "approved, nothing happened" — visible and wrong-in-the-safe-
   * direction, versus a lease scheme that could send twice.
   */
  claimDueReplays(nowIso: string, limit: number): Promise<Decision[]>;

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

    claimForApproval(decisionId, { nowIso, status, replayDueAt, replayClaimedAt }) {
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
    },

    async markReplayed(decisionId, nowIso) {
      const row = await db
        .updateTable(table)
        .set({
          status: 'executed',
          replayed_at: new Date(nowIso),
          replay_due_at: null,
          replay_error: null,
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
    replayError: row.replay_error,
  };
}
