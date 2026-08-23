/**
 * An in-memory `DecisionStore` for the pre-call gate's unit tests.
 *
 * The gate's job is ordering and fail-closed behaviour, and neither needs a
 * database to be wrong. The STORE's own contract — the partial unique index,
 * the conditional updates, the concurrent `takeApproval` pair — is tested
 * against real Postgres in `store.test.ts`, and the two are driven together
 * for real in `decisions.canary.test.ts`. This fake exists so the gate's tests
 * stay fast and hermetic, not to stand in for either of those.
 */
import { RECEIPT_STATUSES } from '../receipts.js';
import type { DecisionStore } from '../store.js';
import { AUTHORISING_STATUSES, type Decision, type DecisionStatus } from '../types.js';

const OPEN: readonly DecisionStatus[] = ['pending', 'stale'];

export interface FakeStore extends DecisionStore {
  rows: Map<string, Decision>;
  /** Make the next call to the named method reject. */
  failNext(method: 'create' | 'takeApproval'): void;
}

export function createFakeStore(): FakeStore {
  const rows = new Map<string, Decision>();
  const failing = new Set<string>();

  function trip(method: string): void {
    if (failing.delete(method)) throw new Error(`fake store: ${method} failed`);
  }

  function open(id: string): Decision | null {
    const row = rows.get(id);
    return row !== undefined && OPEN.includes(row.status) ? row : null;
  }

  return {
    rows,
    failNext(method) {
      failing.add(method);
    },

    async create(decision) {
      trip('create');
      // Mirrors the partial unique index closely enough to catch a caller that
      // forgets it exists.
      for (const row of rows.values()) {
        if (
          row.agentId === decision.agentId &&
          row.callFingerprint === decision.callFingerprint &&
          AUTHORISING_STATUSES.includes(row.status) &&
          row.consumedAt === null &&
          row.replayedAt === null &&
          AUTHORISING_STATUSES.includes(decision.status)
        ) {
          throw new Error('fake store: duplicate unconsumed authorisation');
        }
      }
      rows.set(decision.id, decision);
      return decision;
    },

    async get(decisionId, ownerUserId) {
      const row = rows.get(decisionId);
      if (row === undefined) return null;
      if (ownerUserId !== undefined && row.ownerUserId !== ownerUserId) return null;
      return row;
    },

    async list({ ownerUserId, agentId, status }) {
      return [...rows.values()]
        .filter((r) => r.ownerUserId === ownerUserId)
        .filter((r) => agentId === undefined || r.agentId === agentId)
        .filter((r) => (status === undefined ? OPEN.includes(r.status) : r.status === status))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },

    /**
     * The same rule the real store pushes into SQL, in the shape this fake
     * uses for everything else. It is kept honest by `store.test.ts`, which
     * runs the receipt-candidate cases against both this and real Postgres —
     * a fake that answered a different question would let a caller's test pass
     * over a query that does not work.
     */
    async listReceiptCandidates({ ownerUserId, agentId, limit, before }) {
      return [...rows.values()]
        .filter((r) => r.ownerUserId === ownerUserId && r.agentId === agentId)
        .filter((r) => r.resolvedAt !== null)
        .filter((r) => RECEIPT_STATUSES.includes(r.status))
        .filter(
          (r) =>
            r.status !== 'executed' || r.replayedAt !== null || r.consumedAt !== null,
        )
        .filter((r) => before === undefined || r.resolvedAt! < before)
        .sort((a, b) =>
          a.resolvedAt! === b.resolvedAt!
            ? b.id.localeCompare(a.id)
            : a.resolvedAt! < b.resolvedAt!
              ? 1
              : -1,
        )
        .slice(0, limit);
    },

    async claimForApproval(decisionId, { nowIso, status, replayDueAt, replayClaimedAt }) {
      const row = open(decisionId);
      if (row === null) return null;
      for (const other of rows.values()) {
        if (
          other.id !== decisionId &&
          other.agentId === row.agentId &&
          other.callFingerprint === row.callFingerprint &&
          AUTHORISING_STATUSES.includes(other.status) &&
          other.consumedAt === null &&
          other.replayedAt === null
        ) {
          throw new Error('fake store: duplicate unconsumed authorisation');
        }
      }
      const next: Decision = {
        ...row,
        status,
        resolvedAt: nowIso,
        staleReason: null,
        replayDueAt: replayDueAt ?? null,
        replayClaimedAt: replayClaimedAt ?? null,
        replayedAt: null,
        replayAbandonedAt: null,
        replayError: null,
      };
      rows.set(decisionId, next);
      return next;
    },

    // Mirrors the real store's predicates exactly: `executed`, unconsumed,
    // untaken, un-replayed — the same three columns `restore` and
    // `takeApproval` guard. Null means undo, a consuming agent, or another
    // resolver won the row first.
    async claimReplayFlight(decisionId, nowIso) {
      const row = rows.get(decisionId);
      if (
        row === undefined ||
        row.status !== 'executed' ||
        row.consumedAt !== null ||
        row.replayClaimedAt !== null ||
        row.replayedAt !== null
      ) {
        return null;
      }
      const next: Decision = { ...row, replayClaimedAt: nowIso };
      rows.set(decisionId, next);
      return next;
    },

    // Unconditional on status, mirroring the real store: once the call has
    // gone out the row has to agree with the world, even if an undo landed in
    // between.
    async markReplayed(decisionId, nowIso) {
      const row = rows.get(decisionId);
      if (row === undefined) return null;
      const next: Decision = {
        ...row,
        status: 'executed',
        resolvedAt: row.resolvedAt ?? nowIso,
        replayedAt: nowIso,
        replayDueAt: null,
        replayError: null,
      };
      rows.set(decisionId, next);
      return next;
    },

    async parkForAgent(decisionId) {
      const row = rows.get(decisionId);
      if (row === undefined || row.status !== 'executed') return null;
      const next: Decision = {
        ...row,
        status: 'approved-pending-agent',
        replayDueAt: null,
        // The host relinquished the flight without sending. Leaving the marker
        // set would park a decision the agent is then forbidden to pick up.
        replayClaimedAt: null,
      };
      rows.set(decisionId, next);
      return next;
    },

    async markFailed(decisionId, { error }) {
      const row = rows.get(decisionId);
      if (row === undefined || row.status !== 'executed') return null;
      const next: Decision = {
        ...row,
        status: 'failed',
        replayError: error,
        replayDueAt: null,
      };
      rows.set(decisionId, next);
      return next;
    },

    async markDismissed(decisionId, nowIso) {
      const row = open(decisionId);
      if (row === null) return null;
      const next: Decision = { ...row, status: 'dismissed', resolvedAt: nowIso };
      rows.set(decisionId, next);
      return next;
    },

    async markStale(decisionId, { staleReason, freshness }) {
      const row = open(decisionId);
      if (row === null) return null;
      const next: Decision = {
        ...row,
        status: 'stale',
        staleReason,
        freshness,
        resolvedAt: null,
      };
      rows.set(decisionId, next);
      return next;
    },

    async markExpired(decisionId, nowIso) {
      const row = open(decisionId);
      if (row === null) return null;
      const next: Decision = { ...row, status: 'expired', resolvedAt: nowIso };
      rows.set(decisionId, next);
      return next;
    },

    async restore(decisionId) {
      const row = rows.get(decisionId);
      if (row === undefined) return null;
      if (row.status !== 'dismissed' && !AUTHORISING_STATUSES.includes(row.status)) return null;
      if (row.consumedAt !== null) return null;
      if (row.replayedAt !== null) return null;
      if (row.replayClaimedAt !== null) return null;
      const next: Decision = {
        ...row,
        status: 'pending',
        resolvedAt: null,
        staleReason: null,
        replayDueAt: null,
        replayError: null,
      };
      rows.set(decisionId, next);
      return next;
    },

    async expireDue(nowIso) {
      let moved = 0;
      for (const [id, row] of rows) {
        if (OPEN.includes(row.status) && Date.parse(row.expiresAt) <= Date.parse(nowIso)) {
          rows.set(id, { ...row, status: 'expired', resolvedAt: nowIso });
          moved += 1;
        }
      }
      return moved;
    },

    async claimDueReplays(nowIso, limit) {
      const claimed: Decision[] = [];
      for (const [id, row] of rows) {
        if (claimed.length >= limit) break;
        if (
          row.status === 'executed' &&
          row.replayDueAt !== null &&
          row.replayClaimedAt === null &&
          Date.parse(row.replayDueAt) <= Date.parse(nowIso)
        ) {
          const next: Decision = { ...row, replayDueAt: null, replayClaimedAt: nowIso };
          rows.set(id, next);
          claimed.push(next);
        }
      }
      return claimed;
    },

    /**
     * Mirrors the real store's predicates, with the null check spelled out.
     *
     * SQL does not need it — `NULL <= anything` is unknown, so the age
     * comparison already excludes every attended approval waiting for its warm
     * agent. `Date.parse(null)` being NaN makes JS agree by a route nobody
     * should have to reconstruct while reading a test double, so it is written
     * down here. Stricter than the real store is safe; the reverse would not be.
     */
    async reclaimStrandedFlights({ nowIso, claimedBeforeIso, limit }) {
      const reclaimed: Decision[] = [];
      for (const [id, row] of rows) {
        if (reclaimed.length >= limit) break;
        if (
          row.status === 'executed' &&
          row.replayClaimedAt !== null &&
          Date.parse(row.replayClaimedAt) <= Date.parse(claimedBeforeIso) &&
          row.replayedAt === null &&
          row.consumedAt === null
        ) {
          const next: Decision = {
            ...row,
            status: 'failed',
            replayAbandonedAt: nowIso,
            replayDueAt: null,
          };
          rows.set(id, next);
          reclaimed.push(next);
        }
      }
      return reclaimed;
    },

    async takeApproval(agentId, callFingerprint, nowIso) {
      trip('takeApproval');
      for (const [id, row] of rows) {
        if (
          row.agentId === agentId &&
          row.callFingerprint === callFingerprint &&
          AUTHORISING_STATUSES.includes(row.status) &&
          row.consumedAt === null &&
          row.replayDueAt === null &&
          row.replayClaimedAt === null &&
          row.replayedAt === null
        ) {
          const next: Decision = { ...row, consumedAt: nowIso };
          rows.set(id, next);
          return next;
        }
      }
      return null;
    },
  };
}
