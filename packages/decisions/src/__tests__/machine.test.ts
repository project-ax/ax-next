/**
 * Ported from `packages/channel-web/mock/__tests__/decision-machine.test.ts`.
 * The assertions are unchanged apart from the `ActivityEvent` field edit
 * (`day`/`time` → ISO `at`) and the fields the real `Decision` has that the
 * prototype's did not.
 */
import { describe, expect, it } from 'vitest';
import {
  UNDO_WINDOW_MS,
  approveDecision,
  dismissDecision,
  undoDecision,
} from '../machine.js';
import type { Decision } from '../types.js';

const T0 = '2026-08-20T09:00:00.000Z';
const T_SOON = '2026-08-20T09:00:05.000Z';
const T_LATE = '2026-08-20T13:00:00.000Z';
const T_EXPIRED = '2026-08-23T09:00:00.000Z';

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd-priya',
    agentId: 'inbox',
    ownerUserId: 'u1',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'unattended',
    status: 'pending',
    call: {
      id: 'call-1',
      name: 'gmail__send',
      input: { to: 'priya@northwind.co', body: 'Friday works well.' },
    },
    callFingerprint: 'fp-1',
    ruleId: 'test.rule',
    irreversible: false,
    freshness: {
      kind: 'thread-head',
      value: 'msg-8841',
      label: "Priya's thread, last message 8:41 AM",
    },
    summary: 'A reply to Priya at Northwind is ready',
    detail: 'She asked to move the contract call to Friday.',
    preview: { meta: 'To: priya@northwind.co', body: 'Friday works well.' },
    primaryLabel: 'Send it',
    secondaryLabel: 'Read the draft',
    ghostLabel: "I'll handle it",
    approvedText: 'Inbox sent your reply to Priya Raman',
    dismissedText: "You took it over from Inbox — the draft was kept, nothing was sent",
    createdAt: T0,
    expiresAt: '2026-08-22T09:00:00.000Z',
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayError: null,
    ...over,
  };
}

describe('approveDecision — the freshness guard', () => {
  it('executes when the world has not moved', () => {
    const r = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-8841' },
    });

    expect(r.decision.status).toBe('executed');
    expect(r.decision.staleReason).toBeNull();
    expect(r.event?.kind).toBe('approved');
    // The receipt carries the AUTHORED approved string, and links back to the
    // decision so the Activity row can show what actually went out.
    expect(r.event?.text).toBe('Inbox sent your reply to Priya Raman');
    expect(r.event?.decisionId).toBe('d-priya');
    // The edit this port makes: an ISO instant, not a pre-bucketed "Today".
    expect(r.event?.at).toBe(T_LATE);
  });

  it('executes when there is nothing to re-check', () => {
    const r = approveDecision(decision({ freshness: null }), {
      now: T_LATE,
      freshness: {},
    });
    expect(r.decision.status).toBe('executed');
  });

  it('re-opens instead of executing when the world moved underneath it', () => {
    const r = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-9002' },
      changed: { 'thread-head': 'Priya replied again at 11:20 AM' },
    });

    expect(r.decision.status).toBe('stale');
    expect(r.decision.staleReason).toBe('Priya replied again at 11:20 AM');
    // Nothing was sent, so nothing may be reported as sent.
    expect(r.executed).toBe(false);
    expect(r.event).toBeNull();
  });

  it('drops the "checked against" clause on a stale row (AW-7)', () => {
    // The clause describes HOLD-TIME. Once the guard has tripped it is false,
    // and repeating it underneath an alert saying the opposite is worse than
    // silence (design §3.4). The machine strips it here so no renderer has to
    // decide — and the PREDICATE survives, re-captured, because dropping the
    // sentence is not dropping the guard.
    const r = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-9002' },
    });

    expect(r.decision.freshness).toEqual({
      kind: 'thread-head',
      value: 'msg-9002',
      label: null,
    });
  });

  it('falls back to a generic reason when the guard cannot say what changed', () => {
    const r = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-9002' },
    });
    expect(r.decision.status).toBe('stale');
    expect(r.decision.staleReason).toMatch(/changed since/i);
  });

  it('lets a re-opened decision execute once the human approves it again', () => {
    const stale = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-9002' },
    }).decision;

    const r = approveDecision(stale, {
      now: T_LATE,
      // The human looked, accepted the new state; the guard now matches
      // because re-opening re-captured the head.
      freshness: { 'thread-head': 'msg-9002' },
    });

    expect(r.decision.status).toBe('executed');
    expect(r.decision.staleReason).toBeNull();
  });
});

describe('approveDecision — attendance decides the execution path', () => {
  it('an attended decision is executed by the still-warm agent', () => {
    const r = approveDecision(decision({ attendance: 'attended' }), {
      now: T_SOON,
      freshness: { 'thread-head': 'msg-8841' },
    });
    expect(r.path).toBe('agent-executes');
  });

  it('an unattended decision is replayed by the host', () => {
    const r = approveDecision(decision({ attendance: 'unattended' }), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-8841' },
    });
    expect(r.path).toBe('host-replays');
    // Replay must carry the ORIGINAL recorded call, byte for byte — that is
    // the whole reason the approval card can claim to be WYSIWYG.
    expect(r.replayCall).toEqual(decision().call);
  });

  it('never hands back a replay call when it did not execute', () => {
    const r = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-9002' },
    });
    expect(r.replayCall).toBeNull();
  });
});

describe('approveDecision — idempotency and expiry', () => {
  it('is a no-op on an already-executed decision', () => {
    const once = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-8841' },
    });
    const twice = approveDecision(once.decision, {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-8841' },
    });

    // A double click, a retried POST, two open tabs: exactly one send.
    expect(twice.executed).toBe(false);
    expect(twice.event).toBeNull();
    expect(twice.decision.status).toBe('executed');
  });

  it('refuses a decision that has passed its expiry', () => {
    const r = approveDecision(decision(), {
      now: T_EXPIRED,
      freshness: { 'thread-head': 'msg-8841' },
    });
    expect(r.decision.status).toBe('expired');
    expect(r.executed).toBe(false);
  });

  it('does not resurrect a dismissed decision', () => {
    const dismissed = dismissDecision(decision(), { now: T_SOON }).decision;
    const r = approveDecision(dismissed, {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-8841' },
    });
    expect(r.executed).toBe(false);
    expect(r.decision.status).toBe('dismissed');
  });
});

describe('dismissDecision', () => {
  it('records the authored dismissed line, not a derived one', () => {
    const r = dismissDecision(decision(), { now: T_SOON });
    expect(r.decision.status).toBe('dismissed');
    expect(r.event?.kind).toBe('dismissed');
    expect(r.event?.text).toBe(
      "You took it over from Inbox — the draft was kept, nothing was sent",
    );
    expect(r.event?.at).toBe(T_SOON);
  });

  it('is a no-op once the decision has executed', () => {
    const executed = approveDecision(decision(), {
      now: T_LATE,
      freshness: { 'thread-head': 'msg-8841' },
    }).decision;
    const r = dismissDecision(executed, { now: T_LATE });
    expect(r.decision.status).toBe('executed');
    expect(r.event).toBeNull();
  });
});

describe('undoDecision', () => {
  it('returns an executed decision to pending inside the window', () => {
    const executed = approveDecision(decision(), {
      now: T0,
      freshness: { 'thread-head': 'msg-8841' },
    }).decision;

    const r = undoDecision(executed, { now: T_SOON });
    expect(r.undone).toBe(true);
    expect(r.decision.status).toBe('pending');
  });

  it('refuses once the window has closed', () => {
    const executed = approveDecision(decision(), {
      now: T0,
      freshness: { 'thread-head': 'msg-8841' },
    }).decision;

    const past = new Date(Date.parse(T0) + UNDO_WINDOW_MS + 1).toISOString();
    const r = undoDecision(executed, { now: past });
    expect(r.undone).toBe(false);
    expect(r.decision.status).toBe('executed');
  });

  it('reverses a dismissal too', () => {
    const dismissed = dismissDecision(decision(), { now: T0 }).decision;
    const r = undoDecision(dismissed, { now: T_SOON });
    expect(r.undone).toBe(true);
    expect(r.decision.status).toBe('pending');
  });

  // AW-5: 'approved-pending-agent' is what a host writes when it physically
  // cannot replay a sandbox-only tool — the approval is real, it is just
  // parked for the agent's next run instead of consumed immediately. That is
  // still an authorising status, so a human who said yes by mistake needs the
  // same undo window as any other approval.
  it('reverses a decision parked as approved-pending-agent, inside the window', () => {
    const parked = decision({
      status: 'approved-pending-agent',
      resolvedAt: T0,
    });
    const r = undoDecision(parked, { now: T_SOON });
    expect(r.undone).toBe(true);
    expect(r.decision.status).toBe('pending');
  });

  it('refuses to undo approved-pending-agent once the window has closed', () => {
    const parked = decision({
      status: 'approved-pending-agent',
      resolvedAt: T0,
    });
    const past = new Date(Date.parse(T0) + UNDO_WINDOW_MS + 1).toISOString();
    const r = undoDecision(parked, { now: past });
    expect(r.undone).toBe(false);
    expect(r.decision.status).toBe('approved-pending-agent');
  });
});
