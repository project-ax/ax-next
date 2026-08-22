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
import type { Kysely } from 'kysely';
import type { DecisionRow, DecisionsDatabase } from './migrations.js';
import type {
  Decision,
  DecisionStatus,
  FreshnessPredicate,
  ToolCall,
} from './types.js';

/** The two statuses a human can still act on. */
const OPEN_STATUSES: readonly DecisionStatus[] = ['pending', 'stale'];

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
   * Approve. Conditional on the decision still being open, so a double click
   * collapses to one transition. Throws if a standing unconsumed authorisation
   * already exists for this (agent, call fingerprint) — the partial unique
   * index refuses it, and refusing loudly is the point.
   */
  markExecuted(decisionId: string, nowIso: string): Promise<Decision | null>;
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
   * Undo — back to `pending`, which also drops the standing authorisation
   * (the partial index only covers `status = 'executed'`). Refuses once
   * `consumed_at` is set: that bell cannot be un-rung, and re-approving after
   * a consumed authorisation would authorise a SECOND execution of a call
   * that already ran.
   */
  restore(decisionId: string): Promise<Decision | null>;

  /** Sweep: every open decision past its expiry. Returns how many moved. */
  expireDue(nowIso: string): Promise<number>;

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

    markExecuted(decisionId, nowIso) {
      return transition(decisionId, OPEN_STATUSES, {
        status: 'executed',
        resolved_at: new Date(nowIso),
        // The guard passed, so whatever it said last time is no longer true.
        stale_reason: null,
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
        .set({ status: 'pending', resolved_at: null, stale_reason: null })
        .where('decision_id', '=', decisionId)
        .where('status', 'in', ['executed', 'dismissed'])
        .where('consumed_at', 'is', null)
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

    async takeApproval(agentId, callFingerprint, nowIso) {
      const row = await db
        .updateTable(table)
        .set({ consumed_at: new Date(nowIso) })
        .where('agent_id', '=', agentId)
        .where('call_fingerprint', '=', callFingerprint)
        .where('status', '=', 'executed')
        .where('consumed_at', 'is', null)
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
  };
}
