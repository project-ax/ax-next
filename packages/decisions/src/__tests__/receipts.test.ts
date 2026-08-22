/**
 * The receipt is DERIVED, and these tests are the reason that is safe.
 *
 * There is no receipt table and no receipt event. `receiptFor` reads a decision
 * row and answers what happened, so the receipt cannot outlive, contradict, or
 * lag the row it describes — which is what a persisted one did (design H1, and
 * the whole of TASK-281).
 *
 * The undo case is the one that matters most and is asserted end-to-end against
 * a real store in `decisions.canary.test.ts`: `restore` puts the row back to
 * `pending`, and a `pending` row has no receipt. Nothing is deleted; the
 * receipt simply stops existing.
 */
import { describe, expect, it } from 'vitest';
import { receiptFor, RECEIPT_STATUSES } from '../receipts.js';
import { FAILED_RECEIPT, PENDING_AGENT_RECEIPT } from '../templates.js';
import type { Decision, DecisionStatus } from '../types.js';

const T_RESOLVED = '2026-08-20T09:00:00.000Z';
const T_RAN = '2026-08-20T09:00:10.000Z';

function base(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_1',
    agentId: 'a1',
    ownerUserId: 'u1',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'unattended',
    status: 'executed',
    call: { id: 'tu1', name: 'request_capability', input: { host: 'api.example.com' } },
    callFingerprint: 'fp-1',
    ruleId: 'rule-1',
    irreversible: false,
    freshness: null,
    summary: 'Wants to reach a new site',
    detail: 'It stopped before running request_capability.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No — I'll handle it",
    approvedText: 'You said yes, so it may reach a new site.',
    dismissedText: 'You turned this down. Nothing ran.',
    createdAt: '2026-08-20T08:00:00.000Z',
    expiresAt: '2026-08-22T08:00:00.000Z',
    resolvedAt: T_RESOLVED,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayedAt: null,
    replayError: null,
    ...over,
  };
}

describe('receiptFor — the three outcomes that have one', () => {
  it('a host replay that ran carries the row\'s own approvedText', () => {
    const decision = base({ replayedAt: T_RAN });
    expect(receiptFor(decision)).toEqual({
      decisionId: 'dec_1',
      agentId: 'a1',
      outcome: 'executed',
      receipt: decision.approvedText,
      at: T_RESOLVED,
      error: null,
    });
  });

  it('a call the AGENT took up carries the same line — the call was made either way', () => {
    // The attended path: the warm agent re-issued its held call and the gate
    // let it through once. Nothing fired a receipt for this before, so the
    // Activity feed showed nothing at all for an approval a person had just
    // given and an agent had just acted on.
    expect(receiptFor(base({ consumedAt: T_RAN }))?.outcome).toBe('executed');
  });

  it('a parked row promises the future and never claims the past', () => {
    const r = receiptFor(base({ status: 'approved-pending-agent' }));
    expect(r?.outcome).toBe('pending-agent');
    expect(r?.receipt).toBe(PENDING_AGENT_RECEIPT);
    // H1: the host has not made this call and must not say it has.
    expect(r?.receipt).not.toBe(base().approvedText);
  });

  it('a parked row the agent HAS since performed stops promising and reports', () => {
    // The receipt tracks the row because it is read from the row. A persisted
    // one would still be saying "it will do this the next time it runs" hours
    // after it did.
    const r = receiptFor(
      base({ status: 'approved-pending-agent', consumedAt: T_RAN }),
    );
    expect(r?.outcome).toBe('executed');
    expect(r?.receipt).toBe(base().approvedText);
  });

  it('a failed replay carries the authored failure line, never approvedText', () => {
    const decision = base({ status: 'failed', replayError: 'upstream 503' });
    const r = receiptFor(decision);
    expect(r?.outcome).toBe('failed');
    expect(r?.receipt).toBe(FAILED_RECEIPT);
    expect(r?.receipt).not.toContain(decision.approvedText);
    // The executor's own words are AUDIT TRAIL, carried beside the receipt and
    // never as it.
    expect(r?.error).toBe('upstream 503');
  });
});

describe('receiptFor — the states that have no receipt', () => {
  it('an approved row whose call has not gone out yet has none', () => {
    // The deferred-replay window, and the attended row waiting for its agent.
    // A receipt here would claim something that has not happened, and the undo
    // that is still available would have to take it back.
    expect(receiptFor(base({ replayDueAt: T_RAN }))).toBeNull();
    expect(receiptFor(base())).toBeNull();
  });

  it('an UNDONE decision has none — the row is open again', () => {
    // This is the whole design. `restore` writes `pending` and clears
    // `resolvedAt`; there is no receipt to remove because there was never a
    // receipt to store.
    expect(
      receiptFor(base({ status: 'pending', resolvedAt: null })),
    ).toBeNull();
  });

  it('pending, stale, dismissed and expired rows have none', () => {
    for (const status of ['pending', 'stale', 'dismissed', 'expired'] as DecisionStatus[]) {
      expect(receiptFor(base({ status }))).toBeNull();
    }
  });

  it('a row with no resolution instant has none, however it is marked', () => {
    // Nothing to file it under. Inventing "now" would put a months-old
    // approval at the top of today's feed.
    expect(receiptFor(base({ replayedAt: T_RAN, resolvedAt: null }))).toBeNull();
  });
});

describe('RECEIPT_STATUSES — the coarse filter the store pushes into SQL', () => {
  it('covers every status receiptFor can answer for, and nothing else', () => {
    const all: DecisionStatus[] = [
      'pending',
      'executed',
      'approved-pending-agent',
      'dismissed',
      'stale',
      'expired',
      'failed',
    ];
    // The store's query and this function are two spellings of one rule, in
    // two languages. This is the assertion that keeps them from drifting: any
    // status the mapper can answer for MUST be selectable, or the row silently
    // never reaches a reader.
    const answerable = all.filter(
      (status) =>
        receiptFor(base({ status, replayedAt: T_RAN })) !== null ||
        receiptFor(base({ status })) !== null,
    );
    expect([...RECEIPT_STATUSES].sort()).toEqual(answerable.sort());
  });
});
