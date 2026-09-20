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
import { createFakeStore, type FakeStore } from './fake-store.js';
import { receiptFor, RECEIPT_STATUSES } from '../receipts.js';
import { EXPIRED_RECEIPT, FAILED_RECEIPT, PENDING_AGENT_RECEIPT } from '../templates.js';
import { DecisionStatusSchema, type Decision, type DecisionStatus } from '../types.js';

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
    replayAbandonedAt: null,
    replayError: null,
    ...over,
  };
}

describe('receiptFor — the outcomes that have one', () => {
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

  it('an ABANDONED replay never claims that nothing was completed', () => {
    // TASK-253. The host took the flight and died inside it, and the sweep
    // reclaimed the row so the slot it was holding could be used again. That
    // is a failure of the SYSTEM, not a report from the tool: the crash could
    // have landed either side of the tool's own side effect, so we do not know
    // whether the call went out. `FAILED_RECEIPT` says "Nothing was completed",
    // which is a claim we have no standing to make — and one that would send a
    // person off to redo an action that may already have happened.
    const decision = base({
      status: 'failed',
      replayClaimedAt: T_RESOLVED,
      replayAbandonedAt: T_RAN,
    });
    const r = receiptFor(decision);
    expect(r?.outcome).toBe('failed');
    expect(r?.receipt).not.toBe(FAILED_RECEIPT);
    expect(r?.receipt).not.toContain('Nothing was completed');
    expect(r?.receipt.length).toBeGreaterThan(0);
    // Still never the approved line, which is the one that claims success.
    expect(r?.receipt).not.toContain(decision.approvedText);
    // No executor ever reported anything, so there is no audit detail to carry.
    expect(r?.error).toBeNull();
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

  it('pending and stale rows have none — the question is still OPEN', () => {
    // And that is the whole of the remaining exclusion list. `dismissed` and
    // `expired` used to be in here with them (TASK-447), which put "nothing
    // has been decided yet" and "you decided no" in the same bucket and made
    // the second one invisible. `stale` genuinely belongs: the freshness guard
    // RE-OPENS the row, so it is back in the queue awaiting an answer.
    for (const status of ['pending', 'stale'] as DecisionStatus[]) {
      expect(receiptFor(base({ status }))).toBeNull();
    }
  });

  it('a row with no resolution instant has none, however it is marked', () => {
    // Nothing to file it under. Inventing "now" would put a months-old
    // approval at the top of today's feed.
    expect(receiptFor(base({ replayedAt: T_RAN, resolvedAt: null }))).toBeNull();
  });
});

describe('receiptFor — the outcomes where NOTHING RAN (TASK-447)', () => {
  /**
   * THE BUG, stated once. Activity is the record of what happened to a person,
   * and a decision they turned down happened to them: they were interrupted,
   * they were asked, and they answered. It was filed under "no receipt"
   * alongside rows nobody had answered yet, so the feed showed every decision
   * the person said yes to and none of the ones they said no to — while the
   * rail's "Brought to you" counter, which filters on the window and nothing
   * else, went on counting them.
   *
   * The count was never the wrong number. The feed was missing rows.
   */
  it("a dismissed row carries the row's own dismissedText, as `declined`", () => {
    const decision = base({ status: 'dismissed' });
    const r = receiptFor(decision);
    expect(r?.outcome).toBe('declined');
    expect(r?.receipt).toBe(decision.dismissedText);
    // Authored independently at hold time — never reachable from the approved
    // line by string surgery, which is how a design once shipped "sent your
    // reply" for a reply that was never sent.
    expect(r?.receipt).not.toContain(decision.approvedText);
    expect(r?.at).toBe(T_RESOLVED);
    // Nothing was attempted, so there is no executor detail to carry.
    expect(r?.error).toBeNull();
  });

  it('a dismissed row NEVER reads as a success, whatever markers it carries', () => {
    // Unreachable through the store's transitions — and exactly the kind of
    // "unreachable" that stops being true when somebody adds a status. The
    // status decides first; `replayedAt` / `consumedAt` cannot promote a
    // refusal into "you said yes, so it may…".
    for (const marker of [{ replayedAt: T_RAN }, { consumedAt: T_RAN }]) {
      const r = receiptFor(base({ status: 'dismissed', ...marker }));
      expect(r?.outcome).toBe('declined');
      expect(r?.receipt).toBe(base().dismissedText);
    }
  });

  it('an expired row says it ran out of time — and NOT that you turned it down', () => {
    const decision = base({ status: 'expired' });
    const r = receiptFor(decision);
    expect(r?.outcome).toBe('expired');
    expect(r?.receipt).toBe(EXPIRED_RECEIPT);
    // The load-bearing half. The row HAS a per-decision "nothing happened"
    // sentence, and it is the wrong one: nobody turned this down, the question
    // simply ran out. Attributing a choice to someone who never made one is
    // H1 aimed at the person it misrepresents.
    expect(r?.receipt).not.toBe(decision.dismissedText);
    expect(r?.receipt).not.toContain('turned this down');
    expect(r?.error).toBeNull();
  });

  it('an undone dismissal stops having a receipt, like every other undo', () => {
    // `restore` accepts `dismissed`, writes `pending` and clears `resolvedAt`.
    // Adding an outcome must not add a receipt that survives being taken back.
    expect(receiptFor(base({ status: 'pending', resolvedAt: null }))).toBeNull();
  });
});

describe('the count and the feed, recomputed from the SAME rows (TASK-447)', () => {
  /**
   * Two surfaces, one row set, and EACH asserted against the rows rather than
   * against the other. A test that only checked "the number equals the list
   * length" would pass just as happily with both of them wrong in the same
   * direction — and these two are not measuring the same thing anyway: the
   * counter is every decision RAISED in a window, the feed is every decision
   * SETTLED, newest-first and paged. They can legitimately differ, and a
   * pending row is exactly where they do. What they must never do is disagree
   * about a row that has been answered.
   */
  const OWNER = 'u1';
  const AGENT = 'a1';
  const WINDOW_START = '2026-08-20T00:00:00.000Z';

  function seeded(): FakeStore {
    const store = createFakeStore();
    const rows: Array<[string, Partial<Decision>]> = [
      ['d_approved', { status: 'executed', replayedAt: T_RAN }],
      ['d_declined', { status: 'dismissed' }],
      ['d_expired', { status: 'expired' }],
      ['d_failed', { status: 'failed', replayError: 'the tool threw' }],
      // Raised and still sitting in the queue: counted, nothing to show yet.
      ['d_open', { status: 'pending', resolvedAt: null }],
    ];
    for (const [id, over] of rows) {
      store.rows.set(
        id,
        base({
          id,
          ownerUserId: OWNER,
          agentId: AGENT,
          createdAt: '2026-08-20T08:00:00.000Z',
          callFingerprint: `fp-${id}`,
          ...over,
        }),
      );
    }
    return store;
  }

  it('counts every decision raised in the window, whatever was decided', async () => {
    const store = seeded();
    // Recomputed here from the fixture rather than restated as a literal: the
    // number under test and the number it is checked against must not be two
    // copies of one guess.
    const raisedInWindow = [...store.rows.values()].filter(
      (r) => Date.parse(r.createdAt) >= Date.parse(WINDOW_START),
    ).length;
    expect(raisedInWindow).toBe(5);
    await expect(
      store.count({ ownerUserId: OWNER, agentId: AGENT, since: WINDOW_START }),
    ).resolves.toBe(raisedInWindow);
  });

  it('shows a row for every SETTLED decision — including the declined one', async () => {
    const store = seeded();
    const candidates = await store.listReceiptCandidates({
      ownerUserId: OWNER,
      agentId: AGENT,
      limit: 50,
    });
    const shown = candidates
      .map(receiptFor)
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Every row the person answered, or that answered itself. Derived from the
    // fixture's own statuses, so widening `OPEN_STATUSES` cannot quietly make
    // this pass with fewer rows.
    const settled = [...store.rows.values()]
      .filter((r) => r.resolvedAt !== null)
      .map((r) => r.id);
    expect(new Set(shown.map((r) => r.decisionId))).toEqual(new Set(settled));
    // The one the card was filed for. Before TASK-447 this set was three.
    expect(shown.find((r) => r.decisionId === 'd_declined')?.outcome).toBe('declined');
    // And the open row is still absent, which is the half a "just make the two
    // numbers match" fix would have broken: it HAS been brought to you, and
    // there is nothing yet to report about it.
    expect(shown.map((r) => r.decisionId)).not.toContain('d_open');
  });
});

describe('RECEIPT_STATUSES — the coarse filter the store pushes into SQL', () => {
  /**
   * DERIVED FROM THE ENUM, never hand-listed, and that is the whole value of
   * this test.
   *
   * It used to walk a literal array of the seven statuses — which meant a new
   * `DecisionStatus` added to the union and wired into `receiptFor` but left
   * out of that array sailed straight through the guard whose entire job was
   * to catch exactly that. A hand-maintained list of everything is not a
   * check on everything; it is a check on whatever somebody remembered.
   *
   * `DecisionStatusSchema` is a `z.enum`, so `.options` is the union itself
   * and cannot fall behind it: the schema has to carry every value or the
   * `returns` validation strips resolved rows off the bus, which the canary
   * catches loudly. Deriving from it makes THAT the single list.
   */
  const ALL_STATUSES = DecisionStatusSchema.options as readonly DecisionStatus[];

  it('walks every status the union declares', () => {
    // Guard against the roll-call quietly emptying out — a `filter` over an
    // empty array produces an empty array, which would make the assertion
    // below a green light over nothing.
    expect(ALL_STATUSES.length).toBeGreaterThanOrEqual(7);
  });

  /**
   * WHAT THIS CATCHES, precisely — because the obvious reading of it is wrong
   * and a comment that overstates a guard is worse than no guard.
   *
   * Since TASK-447 there is no separate gate to drift: `RECEIPT_STATUSES` is
   * the complement of `OPEN_STATUSES`, and `receiptFor` is an exhaustive
   * switch over the union, so a status with no answer is a COMPILE error. The
   * two sides agree by construction, and this stays as the sentinel for the
   * construction itself going away — someone reintroducing a literal list
   * here, or an early `return null` above the switch.
   *
   * That is not hypothetical. It is the bug this file found the first time it
   * ran, where a `dismissed` row carrying a spent authorisation read back as a
   * success while the SQL query excluded it and the two halves of the rule
   * silently disagreed — and it is TASK-447, where the literal list dropped
   * two settled statuses out of the feed altogether.
   *
   * The full status x marker cross-check against real Postgres lives in
   * `store.test.ts`, where both spellings can actually be run against each
   * other. This is its cheap hermetic sentinel, not a replacement for it.
   */
  it('answers for exactly the statuses it lists, so the gate cannot drift', () => {
    const answerable = ALL_STATUSES.filter(
      (status) =>
        receiptFor(base({ status, replayedAt: T_RAN })) !== null ||
        receiptFor(base({ status })) !== null,
    );
    expect([...RECEIPT_STATUSES].sort()).toEqual([...answerable].sort());
  });
});
