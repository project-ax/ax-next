/**
 * The undo affordance must go away when the CALL HAPPENS, not when the clock
 * runs out.
 *
 * `Decision.undoable` is the server's answer to "can this still be taken
 * back", and it goes false the moment the agent consumes the standing
 * authorisation. The bug this file exists to prevent: the queue applied the
 * row the approve POST handed back — captured a millisecond after
 * `resolvedAt`, so always `undoable: true` — and then never read the row
 * again, which made `undoSecondsLeft`'s first gate unreachable and left the
 * button counting down on the clock alone. Measured on a kind walk: the call
 * went out at +3.7s and the button still read "Undo · 6s" at +5s.
 *
 * So every assertion below stays WELL INSIDE the ten-second window. A test
 * that let the clock run out would pass on the timer and prove nothing about
 * the signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-types';
import { UNDO_WINDOW_MS } from '@/lib/workspace-types';
import {
  DECISION_GOING_OUT,
  DECISION_GOING_OUT_NOTE,
  DECISION_ROUTINE_UNDERWAY,
  DECISION_ROUTINE_UNDERWAY_NOTE,
  DECISION_UNDO_TOO_LATE,
  decisionOutcome,
  undoSecondsLeft,
} from '@/components/workspace/decision-copy';
import { DecisionRow } from '@/components/workspace/DecisionRow';

const listDecisions = vi.fn();
const readDecision = vi.fn();
const approveDecision = vi.fn();
const dismissDecision = vi.fn();
const undoDecision = vi.fn();

// The METHODS are stubbed; `WorkspaceShapeError` is passed through from the
// real module. The malformed-body test below injects a genuine one, so the
// rejection this file exercises is the same object the guard in
// `workspace-api.ts` actually throws — not a look-alike that could drift.
vi.mock('../lib/workspace-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspace-api')>()),
  workspaceApi: {
    decisions: (...a: unknown[]) => listDecisions(...a),
    decision: (...a: unknown[]) => readDecision(...a),
    approveDecision: (...a: unknown[]) => approveDecision(...a),
    dismissDecision: (...a: unknown[]) => dismissDecision(...a),
    undoDecision: (...a: unknown[]) => undoDecision(...a),
  },
}));

import { useDecisionQueue } from '../lib/workspace-decisions';
import { WorkspaceShapeError } from '../lib/workspace-api';
import {
  decisionFixture,
  resolvedFixture,
} from '../components/workspace/__tests__/decision-fixture';

/** The poll cadence the hook uses. Kept in step with `UNDO_POLL_MS`. */
const POLL_MS = 1000;

/** Flush pending microtasks (mocked fetches) without touching the clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Advance the fake clock and let anything it started resolve. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mount the hook with `rows` already in the queue. */
async function mountWith(rows: Decision[]) {
  listDecisions.mockResolvedValue({ decisions: rows });
  const handle = renderHook(() => useDecisionQueue());
  await settle();
  return handle;
}

describe('useDecisionQueue — the undo window is closed by the server, not the clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    listDecisions.mockReset();
    readDecision.mockReset();
    approveDecision.mockReset();
    dismissDecision.mockReset();
    undoDecision.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the undo affordance when the server says the call has been consumed', async () => {
    const open = decisionFixture();
    const { result } = await mountWith([open]);

    // Approve. The response is what the server can honestly say at that
    // instant: resolved, and nothing has consumed the authorisation yet.
    const justApproved = resolvedFixture('executed');
    approveDecision.mockResolvedValue({
      decision: justApproved,
      executed: true,
      path: null,
      error: null,
      pendingUntil: null,
    });
    act(() => result.current.approve(open.id));
    await settle();
    expect(result.current.decisions[0]!.undoable).toBe(true);
    expect(undoSecondsLeft(result.current.decisions[0]!)).toBeGreaterThan(0);

    // Now the agent takes the authorisation up at the pre-call gate, so the
    // server's answer changes. Nothing else about the row does.
    readDecision.mockResolvedValue({
      decision: resolvedFixture('executed', {
        resolvedAt: justApproved.resolvedAt,
        undoable: false,
      }),
    });

    await tick(POLL_MS);

    expect(readDecision).toHaveBeenCalledWith(open.id);
    expect(result.current.decisions[0]!.undoable).toBe(false);
    // The control is gone. And it is gone on the SIGNAL: we are still a long
    // way inside the window, so a clock-driven implementation would still be
    // counting down here.
    expect(undoSecondsLeft(result.current.decisions[0]!)).toBe(0);
    expect(Date.now() - Date.parse(justApproved.resolvedAt!)).toBeLessThan(
      UNDO_WINDOW_MS,
    );
  });

  it('never polls a queue of rows nobody has resolved', async () => {
    await mountWith([decisionFixture(), decisionFixture({ id: 'd-2' })]);
    await tick(POLL_MS * 5);
    expect(readDecision).not.toHaveBeenCalled();
  });

  it('stops polling once the row can no longer be taken back', async () => {
    const resolved = resolvedFixture('executed');
    const { result } = await mountWith([resolved]);

    readDecision.mockResolvedValue({
      decision: resolvedFixture('executed', {
        resolvedAt: resolved.resolvedAt,
        undoable: false,
      }),
    });
    await tick(POLL_MS);
    const callsAtFlip = readDecision.mock.calls.length;
    expect(callsAtFlip).toBe(1);
    expect(result.current.decisions[0]!.undoable).toBe(false);

    // Three more cadences, still inside the ten seconds. Nothing further is
    // asked for: an affordance that is already gone has nothing left to learn.
    await tick(POLL_MS * 3);
    expect(readDecision.mock.calls.length).toBe(callsAtFlip);
  });

  it('leaves the row exactly as it was when a poll fails, and says nothing', async () => {
    const resolved = resolvedFixture('executed');
    const { result } = await mountWith([resolved]);

    readDecision.mockRejectedValue(new Error('offline'));
    await tick(POLL_MS);

    // A blip is not news. The row keeps saying what the server last told us,
    // and nobody clicked anything, so nobody is owed a notice.
    expect(result.current.decisions[0]).toEqual(resolved);
    expect(result.current.decisions[0]!.undoable).toBe(true);
    expect(result.current.notices.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('leaves a trace once a run of re-reads has failed, and not before', async () => {
    /*
      The poll is silent to a PERSON on purpose. But a route that is genuinely
      broken produces exactly the symptom this card exists to fix — Undo
      lingering the full ten seconds — with nothing anywhere saying why. So a
      run of failures on one row is noted for whoever is looking, once.
    */
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const resolved = resolvedFixture('executed');
      await mountWith([resolved]);
      readDecision.mockRejectedValue(new Error('offline'));

      // One blip is not a story.
      await tick(POLL_MS);
      expect(debug).not.toHaveBeenCalled();
      await tick(POLL_MS);
      expect(debug).not.toHaveBeenCalled();

      // Three in a row is.
      await tick(POLL_MS);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]![0])).toContain(resolved.id);

      // And it says it once, not once a second.
      await tick(POLL_MS * 3);
      expect(debug).toHaveBeenCalledTimes(1);
    } finally {
      debug.mockRestore();
    }
  });

  it('refuses to let an in-flight poll un-do an undo', async () => {
    const resolved = resolvedFixture('executed');
    const { result } = await mountWith([resolved]);

    // A poll goes out and does not come back yet.
    let releasePoll: (out: { decision: Decision }) => void = () => {};
    readDecision.mockReturnValue(
      new Promise<{ decision: Decision }>((res) => {
        releasePoll = res;
      }),
    );
    await tick(POLL_MS);
    expect(readDecision).toHaveBeenCalledTimes(1);

    // Meanwhile the person hits Undo and the server takes it back: the row is
    // pending again, and there is nothing left to undo.
    const takenBack = decisionFixture({ status: 'pending', undoable: false });
    undoDecision.mockResolvedValue({ decision: takenBack, undone: true });
    act(() => result.current.undo(resolved.id));
    await settle();
    expect(result.current.decisions[0]!.status).toBe('pending');

    // The stale poll finally lands, carrying the APPROVED row. Applying it
    // would put the approval back on screen — the click would visibly
    // un-happen. It is dropped.
    await act(async () => {
      releasePoll({ decision: resolved });
      await Promise.resolve();
    });
    expect(result.current.decisions[0]).toEqual(takenBack);
    expect(result.current.decisions[0]!.undoable).toBe(false);
  });

  /*
    A poll that comes back malformed must degrade, not take the surface down.

    `applyPolledRow` is typed `(row: Decision)` and reads `row.id` inside a
    `setDecisions` updater — during React's render phase, where the poll's own
    `.catch` cannot see a throw. Before TASK-273's per-surface boundaries a
    null row there unmounted the entire chat. That was survivable while only the
    flag-gated /workspace mounted this queue; TASK-261 puts it on the default
    surface, where the poll runs once a second for anyone mid-undo-window.

    The guard is at the API boundary, so this rejects and lands in the `.catch`
    that already exists for a failed poll: the row is left exactly as the server
    last described it, and nobody is told anything, because nobody clicked.
  */
  it('survives a REJECTED poll and leaves the row untouched', async () => {
    const resolved = resolvedFixture('executed');
    const { result } = await mountWith([resolved]);
    const before = result.current.decisions[0];

    // What a proxy or a host at a different version can produce: a 200 whose
    // body is not a decision read.
    // The guard in `workspace-api.ts` turns a malformed body into exactly this
    // rejection, so that is what we inject. To be clear about the seam: this
    // test exercises the CONSUMER's `.catch`, not the guard — the guard has its
    // own test in `workspace-api-decision-shape.test.ts`, and reverting it would
    // redden that file rather than this one. Using the real error type is what
    // makes the two halves visibly meet.
    readDecision.mockRejectedValue(new WorkspaceShapeError('/decisions/d1'));
    await tick(POLL_MS);

    // Still mounted, still honest.
    expect(result.current.decisions[0]).toEqual(before);
    expect(result.current.error).toBeNull();
    expect(result.current.notices.size).toBe(0);
  });

  /*
    TASK-441 — a server-REFUSED undo must stop being offered.

    The seam under test is the whole one: the response the SERVER actually
    sends on a refusal goes in, and what a person can press comes out. So the
    mock below answers the unchanged row — `undoable: true`, resolved a moment
    ago — which is what `@ax/decisions` returns when the ten seconds have run
    out server-side (`machine.ts`: the time-window branch hands back `d`
    untouched) and what the host on the TASK-358 walk sent. Nothing in this
    test hands the hook a pre-narrowed row; if the hook applied the response
    verbatim the button would still be there, which is the defect.

    It is deliberately NOT a `screen.*` assertion about one render. The button
    either exists as a pressable control after the refusal or it does not, and
    the clock is advanced afterwards to prove it does not come back — a
    clock-driven implementation would still be counting down at +3s.
  */
  const AGENT: WorkspaceAgent = {
    id: 'scheduler',
    name: 'Scheduler',
    state: 'waiting',
    now: 'Waiting on your decision',
    counter: null,
    startedAt: null,
    stoppedReason: null,
  };

  /** The queue wired to the real row renderer, exactly as `TodayView` wires it. */
  function Queue() {
    const q = useDecisionQueue();
    return (
      <>
        {q.decisions.map((d) => (
          <DecisionRow
            key={d.id}
            decision={d}
            agent={AGENT}
            expanded
            onToggle={() => {}}
            onOpenAgent={() => {}}
            onApprove={() => q.approve(d.id)}
            onDismiss={() => q.dismiss(d.id)}
            onUndo={() => q.undo(d.id)}
            busy={q.busyIds.has(d.id)}
            notice={q.notices.get(d.id) ?? null}
          />
        ))}
      </>
    );
  }

  /** Every Undo control on screen, hidden ones included. */
  function undoControls(): HTMLElement[] {
    return screen.queryAllByRole('button', { name: /undo/i, hidden: true });
  }

  it('stops offering Undo once the server has refused one', async () => {
    const open = decisionFixture();
    listDecisions.mockResolvedValue({ decisions: [open] });
    render(<Queue />);
    await settle();

    const justApproved = resolvedFixture('executed');
    approveDecision.mockResolvedValue({
      decision: justApproved,
      executed: true,
      path: null,
      error: null,
      pendingUntil: null,
    });
    fireEvent.click(screen.getByRole('button', { name: open.primaryLabel }));
    await settle();

    // The window is open and the affordance is real.
    expect(undoControls()).toHaveLength(1);

    // The server refuses: the window shut between the click and the POST. The
    // row comes back exactly as it was — nothing consumed it, nothing replayed
    // it, so nothing about it has changed. The re-read is armed with the same
    // unchanged row, so that a regression which DOES poll gets the answer a
    // real server would give rather than an undefined body.
    const refused = { ...justApproved };
    undoDecision.mockResolvedValue({ decision: refused, undone: false });
    readDecision.mockResolvedValue({ decision: refused });

    fireEvent.click(undoControls()[0]!);
    await settle();

    expect(undoDecision).toHaveBeenCalledTimes(1);
    // THE AFFORDANCE IS GONE — not hidden, not disabled. There is no control
    // to click and none to reach with a Tab, so a second request cannot be
    // sent from this surface at all.
    expect(undoControls()).toHaveLength(0);
    /*
      ...and the explanation stayed. Withdrawing the button must not also
      swallow the reason it went.

      TWO nodes carry that sentence since TASK-442: the line the person reads,
      and the `sr-only` live region that announces it to a screen reader. This
      case is about the VISIBLE one — the announcer is asserted in
      `components/workspace/__tests__/consent-announce.test.tsx` — so it asks
      for exactly that rather than for "an element with this text", and pins
      the count so a third copy would fail here rather than pass quietly.
    */
    const explanation = screen
      .getAllByText(DECISION_UNDO_TOO_LATE)
      .filter((el) => !el.hasAttribute('data-consent-said'));
    expect(explanation).toHaveLength(1);
    // The receipt itself is untouched.
    expect(screen.getByTestId(`decision-${open.id}`).dataset.status).toBe('executed');

    // Three seconds on — still well inside the ten a clock-driven
    // implementation would be counting down.
    await tick(POLL_MS * 3);
    expect(Date.now() - Date.parse(justApproved.resolvedAt!)).toBeLessThan(
      UNDO_WINDOW_MS,
    );
    // The button has not come back, and nothing has asked the server to undo
    // anything a second time.
    expect(undoControls()).toHaveLength(0);
    expect(undoDecision).toHaveBeenCalledTimes(1);
    /*
      And the re-read never ran, which is the stronger fact and the reason it
      cannot bring the button back. A row with no undo left drops out of
      `watchedKey`, so the effect early-returns and clears its interval — the
      row stops being polled at all, rather than being polled and ignored.
      (`applyPolledRow`'s "still inside its own window" guard is the second
      line of that defence, and has its own test above.)
    */
    expect(readDecision).not.toHaveBeenCalled();

    cleanup();
  });
});

/*
  TASK-574 — the host defers the attended continuation until the undo window
  closes, and the thread schedules its attach for then. An Undo the server
  ACCEPTED means that continuation never runs, so the queue has to say so —
  otherwise the thread attaches to an id nothing will ever stream on and sits
  on "Thinking…" forever. A REFUSED undo leaves the approval standing, and the
  continuation with it.
*/
describe('useDecisionQueue — onDecisionUndone (TASK-574)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    listDecisions.mockReset();
    readDecision.mockReset();
    approveDecision.mockReset();
    undoDecision.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function mountWithHooks(
    rows: Decision[],
    hooks: Parameters<typeof useDecisionQueue>[0],
  ) {
    listDecisions.mockResolvedValue({ decisions: rows });
    const handle = renderHook(() => useDecisionQueue(hooks));
    await settle();
    return handle;
  }

  it('calls onDecisionUndone with the id when the server takes the approval back', async () => {
    const onDecisionUndone = vi.fn();
    const resolved = resolvedFixture('executed');
    const { result } = await mountWithHooks([resolved], { onDecisionUndone });

    undoDecision.mockResolvedValue({
      decision: decisionFixture({ status: 'pending', undoable: false }),
      undone: true,
    });
    act(() => result.current.undo(resolved.id));
    await settle();

    expect(onDecisionUndone).toHaveBeenCalledTimes(1);
    expect(onDecisionUndone).toHaveBeenCalledWith(resolved.id);
  });

  it('does NOT call onDecisionUndone when the server refuses the undo', async () => {
    const onDecisionUndone = vi.fn();
    const resolved = resolvedFixture('executed');
    const { result } = await mountWithHooks([resolved], { onDecisionUndone });

    // Refused: the approval stands, so the deferred continuation still runs.
    undoDecision.mockResolvedValue({ decision: resolved, undone: false });
    act(() => result.current.undo(resolved.id));
    await settle();

    expect(onDecisionUndone).not.toHaveBeenCalled();
  });

  it('does NOT call onDecisionUndone when the undo POST fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onDecisionUndone = vi.fn();
    const resolved = resolvedFixture('executed');
    const { result } = await mountWithHooks([resolved], { onDecisionUndone });

    undoDecision.mockRejectedValue(new Error('network'));
    act(() => result.current.undo(resolved.id));
    await settle();

    expect(onDecisionUndone).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('hands onDecisionApproved the approve response pendingUntil when the row lacks one', async () => {
    const onDecisionApproved = vi.fn();
    const open = decisionFixture();
    const { result } = await mountWithHooks([open], { onDecisionApproved });

    const due = new Date(Date.now() + UNDO_WINDOW_MS).toISOString();
    approveDecision.mockResolvedValue({
      decision: resolvedFixture('executed', { pendingUntil: null }),
      executed: false,
      path: 'agent-executes',
      error: null,
      pendingUntil: due,
      streamReqId: 'req-1',
    });
    act(() => result.current.approve(open.id));
    await settle();

    expect(onDecisionApproved).toHaveBeenCalledTimes(1);
    const [decision, streamReqId] = onDecisionApproved.mock.calls[0]!;
    expect(streamReqId).toBe('req-1');
    expect(decision.pendingUntil).toBe(due);
  });
});

describe('routine scope after the grace window', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z')); listDecisions.mockReset(); readDecision.mockReset(); approveDecision.mockReset(); });
  afterEach(() => vi.useRealTimers());
  it.each(['succeeded', 'failed'] as const)('retains and polls an Allow once unknown outcome after grace until %s', async (routineOutcome) => {
    const pending = resolvedFixture('executed', { routineOperation: 'routine_update', approvalScope: 'once', routineOutcome: null, undoable: false, pendingUntil: new Date(Date.now() - 1000).toISOString(), resolvedAt: new Date(Date.now() - 60000).toISOString(), approvedText: 'The approved routine operation completed.' });
    expect(decisionOutcome(pending)?.tone).toBe('quiet');
    expect(decisionOutcome(pending)?.line).toBe(DECISION_ROUTINE_UNDERWAY);
    expect(decisionOutcome(pending)?.note).toBe(DECISION_ROUTINE_UNDERWAY_NOTE);
    readDecision.mockResolvedValue({ decision: pending });
    const { result } = await mountWith([pending]);
    listDecisions.mockResolvedValue({ decisions: [] });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.decisions).toHaveLength(1);
    await tick(POLL_MS * 3);
    expect(readDecision).toHaveBeenCalledTimes(3);
    expect(result.current.decisions[0]?.routineOutcome).toBeNull();
    readDecision.mockResolvedValue({ decision: { ...pending, routineOutcome } });
    await tick(POLL_MS);
    expect(decisionOutcome(result.current.decisions[0]!)?.tone).toBe(routineOutcome === 'succeeded' ? 'done' : 'bad');
    await tick(POLL_MS * 2);
    expect(readDecision).toHaveBeenCalledTimes(4);
  });
  it('reads a routine approval in its undo window as about to go ahead; a recorded outcome beats the clock (TASK-941)', () => {
    const waiting = resolvedFixture('executed', {
      routineOperation: 'routine_fire_now', approvalScope: 'once', consentDeliveryState: 'none',
      routineOutcome: null, irreversible: true, pendingUntil: new Date(Date.now() + 9_000).toISOString(),
    });
    expect(decisionOutcome(waiting)).toEqual({ line: DECISION_GOING_OUT, note: DECISION_GOING_OUT_NOTE, tone: 'quiet' });
    expect(decisionOutcome({ ...waiting, routineOutcome: 'succeeded' })).toEqual({ line: 'The routine run was accepted.', note: null, tone: 'done' });
    expect(decisionOutcome({ ...waiting, pendingUntil: new Date(Date.now() - 1_000).toISOString() })).toEqual({
      line: DECISION_ROUTINE_UNDERWAY, note: DECISION_ROUTINE_UNDERWAY_NOTE, tone: 'quiet',
    });
  });
  it('reads an Always Allow approval in its undo window as about to go ahead, not as unfinished (TASK-941)', () => {
    const waiting = resolvedFixture('executed', {
      routineOperation: 'routine_create', approvalScope: 'agent-routines', consentDeliveryState: 'pending',
      consentGranted: null, routineOutcome: null, pendingUntil: new Date(Date.now() + 9_000).toISOString(),
    });
    expect(decisionOutcome(waiting)).toEqual({ line: 'Routine permission is waiting to be delivered.', note: DECISION_GOING_OUT_NOTE, tone: 'quiet' });
    // After the window the consent branch's own note is back; a recorded outcome still beats the clock.
    expect(decisionOutcome({ ...waiting, pendingUntil: new Date(Date.now() - 1_000).toISOString() })?.note).toBe('The original routine change has not completed.');
    expect(decisionOutcome({ ...waiting, routineOutcome: 'succeeded' })?.note).toBe('The original routine change completed.');
  });
  it('uses durable outcomes for every routine tool, keeps run acceptance honest, and separates permission delivery', () => {
    for (const routineOperation of ['routine_create', 'routine_update', 'routine_delete', 'routine_fire_now'] as const) {
      const pending = resolvedFixture('executed', { routineOperation, approvalScope: 'once', routineOutcome: null, undoable: false });
      expect(decisionOutcome(pending)?.tone).toBe('quiet');
      expect(decisionOutcome({ ...pending, routineOutcome: 'failed' })?.tone).toBe('bad');
      expect(decisionOutcome({ ...pending, routineOutcome: 'succeeded' })?.line).toBe(routineOperation === 'routine_fire_now' ? 'The routine run was accepted.' : 'The approved routine operation completed.');
    }
    const standing = resolvedFixture('executed', { routineOperation: 'routine_create', approvalScope: 'agent-routines', consentDeliveryState: 'delivered', consentGranted: true, routineOutcome: null });
    expect(decisionOutcome(standing)).toMatchObject({ line: 'Routine permission delivered.', note: 'The original routine change has not completed.', tone: 'quiet' });
    expect(decisionOutcome({ ...standing, consentDeliveryState: 'failed', routineOutcome: 'succeeded' })).toMatchObject({ line: 'Routine permission could not be delivered.', note: 'The original routine change completed.', tone: 'bad' });
    const unrelated = resolvedFixture('executed', { undoable: false });
    expect(decisionOutcome(unrelated)).toEqual({ line: unrelated.approvedText, note: null, tone: 'done' });
  });
  it('keeps watching pending consent after Undo ends and applies delivered permission separately from expiry', async () => {
    const pending = resolvedFixture('executed', { approvalScope: 'agent-routines', consentDeliveryState: 'pending', consentGranted: null, routineOutcome: null, undoable: false, resolvedAt: new Date(Date.now() - 11000).toISOString() });
    const changed = vi.fn(); window.addEventListener('ax:routine-permissions-changed',changed);
    const {result} = await mountWith([pending]);
    readDecision.mockResolvedValue({ decision: {...pending, status: 'expired', consentDeliveryState: 'delivered', consentGranted: true} });
    await tick(POLL_MS);
    expect(readDecision).toHaveBeenCalledWith(pending.id);
    expect(result.current.decisions[0]).toMatchObject({status:'expired',consentDeliveryState:'delivered',consentGranted:true,routineOutcome:null});
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0]![0] as CustomEvent).detail).toEqual({agentId:pending.agentId});
    window.removeEventListener('ax:routine-permissions-changed',changed);
  });
});

/*
  TASK-933 — the host names the task an approval came from (`checkIn`) on an
  OPEN row only. A resolved row's answers carry null (the approve and dismiss
  answers, every poll of a receipt), and so does any answer whose label lookup
  missed its deadline. Today groups approvals under their task by that label,
  so taking such an answer verbatim would move the receipt out of its task's
  block in the middle of its undo window.
*/
describe('useDecisionQueue — an answered row keeps its task (TASK-933)', () => {
  const LABEL = { routineId: 't1', taskName: 'Zero open support tickets' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    listDecisions.mockReset();
    readDecision.mockReset();
    approveDecision.mockReset();
    dismissDecision.mockReset();
    undoDecision.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a poll that answers without a task keeps the row's task", async () => {
    const resolved = resolvedFixture('executed', { id: 'd1', checkIn: LABEL });
    const { result } = await mountWith([resolved]);
    readDecision.mockResolvedValue({ decision: { ...resolved, checkIn: null } });

    await tick(POLL_MS);

    expect(readDecision).toHaveBeenCalledWith('d1');
    expect(result.current.decisions[0]!.checkIn).toStrictEqual(LABEL);
  });

  it("an approve answer without a task keeps the row's task", async () => {
    const open = decisionFixture({ id: 'd1', checkIn: LABEL });
    const { result } = await mountWith([open]);
    approveDecision.mockResolvedValue({
      decision: resolvedFixture('executed', { id: 'd1', checkIn: null }),
      executed: true,
      path: 'host-replays',
      error: null,
      pendingUntil: null,
      streamReqId: null,
    });

    act(() => result.current.approve('d1'));
    await settle();

    expect(result.current.decisions[0]!.status).toBe('executed');
    expect(result.current.decisions[0]!.checkIn).toStrictEqual(LABEL);
  });

  it('a newer task name replaces the old one', async () => {
    const resolved = resolvedFixture('executed', { id: 'd1', checkIn: LABEL });
    const { result } = await mountWith([resolved]);
    const renamed = { routineId: 't1', taskName: 'Renamed' };
    readDecision.mockResolvedValue({ decision: { ...resolved, checkIn: renamed } });

    await tick(POLL_MS);

    expect(readDecision).toHaveBeenCalledWith('d1');
    expect(result.current.decisions[0]!.checkIn).toStrictEqual(renamed);
  });

  it("a fresh list read still decides an open row's task", async () => {
    const open = decisionFixture({ id: 'd1', checkIn: LABEL });
    const { result } = await mountWith([open]);
    expect(result.current.decisions[0]!.checkIn).toStrictEqual(LABEL);

    // The server's fresh word on an open row (its task deleted, say): the list read wins.
    listDecisions.mockResolvedValue({ decisions: [{ ...open, checkIn: null }] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.decisions[0]!.checkIn).toBeNull();
  });
});
