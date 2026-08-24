/**
 * `<InThreadApprovals />` — the approval control on the default `/` surface.
 *
 * The bug this guards is not a rendering nicety. Before TASK-261 a held tool
 * call on `/` produced prose asking the reader to approve something, and there
 * was nothing on screen able to approve it — the card only ever mounted behind
 * a preview flag on `/workspace`.
 *
 * These tests drive the REAL `useDecisionQueue` against a stubbed
 * `workspaceApi`, because the parts most worth protecting (a failed read is not
 * an empty queue; a click reaches the route) live in the seam between them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InThreadApprovals } from '../components/InThreadApprovals';
import { decisionRaisedActions } from '../lib/decision-raised-store';
import {
  workspaceApi,
  WorkspaceApiError,
  type Decision,
} from '../lib/workspace-api';
import {
  DECISION_READ_FAILED,
  DECISION_READ_FAILED_TITLE,
  DECISION_READ_RETRYING,
  DECISION_SESSION_EXPIRED,
  DECISION_SESSION_EXPIRED_TITLE,
} from '../components/workspace/decision-copy';
import { READ_RETRY_DELAYS_MS } from '../lib/conversation-decisions';
import { signInWithGoogle } from '../lib/auth';

// The Sign in button starts the one sign-in this app has. The real thing
// navigates the window, which a jsdom test cannot survive.
vi.mock('../lib/auth', () => ({
  signInWithGoogle: vi.fn(async () => undefined),
}));
import {
  decisionFixture,
  resolvedFixture,
} from '../components/workspace/__tests__/decision-fixture';

// Same shape as permission-card.test.tsx: a plain function over a mutable
// holder. Spying on the real hook would swap a `useSyncExternalStore`-backed
// hook for a constant mid-lifecycle and break the rules of hooks.
let mockConversationId: string | null = 'c1';
vi.mock('../lib/use-conversation-id', () => ({
  useConversationId: () => mockConversationId,
  setActiveConversationId: () => undefined,
}));

/** The list route answers with these rows. */
function serveDecisions(decisions: Decision[]) {
  return vi
    .spyOn(workspaceApi, 'decisions')
    .mockResolvedValue({ decisions });
}

describe('InThreadApprovals', () => {
  beforeEach(() => {
    mockConversationId = 'c1';
    decisionRaisedActions.resetForTest();
  });
  afterEach(() => {
    // The retry tests below run on fake timers; a test that threw before its
    // own restore must not leave them installed for the next one.
    vi.useRealTimers();
    vi.restoreAllMocks();
    decisionRaisedActions.resetForTest();
  });

  /*
    Fake-timer act helpers, hoisted here from the retry `describe` because the
    dedupe test needs them too. Same shape as
    `workspace-decision-queue.test.tsx`: advance past what would change the
    answer, then assert it did not change.

    They also let the read tests drop their real-timer `waitFor`s. That is a
    LATENCY-BUDGET change, not a correctness one, and the distinction matters:
    those waits do hold, and that is MEASURED, not reasoned (2026-08-24,
    TASK-320 — the earlier version of this comment claimed a mutation run that
    had never happened). Baseline for this file is 22/22. Reduce the
    `conversationId` filter in `conversation-decisions.ts` to
    `const mine = decisions;` and it goes 1 failed / 21 passed: "renders
    nothing for a decision belonging to a different conversation". Reduce the
    `raised > 0` gate in `InThreadApprovals.tsx` to `error?.kind === 'failed'`
    and it goes 3 failed / 19 passed — three of the five cases that assert
    `DECISION_READ_FAILED_TITLE` is absent. The other two survive it on the
    `kind` half of the same expression rather than on `raised`: one asserts the
    banner is gone after a retry SUCCEEDS (no `failed` error left to show),
    the other is the 401 case (kind `expired`). They hold, though not for the
    tempting reason. `waitFor`'s FIRST check runs synchronously, before the
    read's `setState` has committed; what puts committed state behind the
    assertions that follow it is that RTL will not resolve `waitFor` until it
    has awaited a `setTimeout(…, 0)`. Either way they were asserting over real
    state, so this is not a correctness fix. What they carried was RTL's 1000ms
    default on a package whose suite has been measured several times slower
    than idle under CI load. `settle()` takes the clock out of the question and
    pins an exact call count while it is there.
  */
  /** Let a read settle without moving any retry timer. */
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('renders the open decision for the active conversation, with its own labels', async () => {
    serveDecisions([decisionFixture()]);
    render(<InThreadApprovals />);

    expect(await screen.findByTestId('approval-d-marcus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeInTheDocument();
    // The region is announced, but nothing steals focus.
    expect(
      screen.getByRole('region', { name: 'Waiting for your approval' }),
    ).toBeInTheDocument();
  });

  it('renders nothing for a decision belonging to a different conversation', async () => {
    vi.useFakeTimers();
    const read = serveDecisions([
      decisionFixture({ id: 'd-other', conversationId: 'c2' }),
    ]);
    const { container } = render(<InThreadApprovals />);

    // The row is in and still nothing is drawn — off a settled read rather
    // than a wall-clock wait. See `settle` above for why that swap is about the
    // budget, not the assertion.
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('approval-d-other')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on the welcome state, where there is no conversation yet', async () => {
    mockConversationId = null;
    vi.useFakeTimers();
    const read = serveDecisions([decisionFixture({ conversationId: 'c1' })]);
    const { container } = render(<InThreadApprovals />);

    // Off a settled read, not a wall-clock wait — see `settle` above.
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toBeNull();
  });

  it('shows ONE card — the oldest — plus a count of what is behind it', async () => {
    serveDecisions([
      decisionFixture({
        id: 'd-newer',
        summary: 'Newer',
        createdAt: new Date(Date.now() - 1000).toISOString(),
      }),
      decisionFixture({
        id: 'd-older',
        summary: 'Older',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    render(<InThreadApprovals />);

    // The oldest is the one on screen; the newer one waits its turn rather than
    // being pushed off the top of a fixed, upward-growing cluster.
    expect(await screen.findByTestId('approval-d-older')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-d-newer')).toBeNull();
    expect(screen.getByText('1 of 2 waiting on you')).toBeInTheDocument();
  });

  it('says nothing about a queue of one', async () => {
    serveDecisions([decisionFixture()]);
    render(<InThreadApprovals />);
    await screen.findByTestId('approval-d-marcus');
    expect(screen.queryByText(/waiting on you$/)).toBeNull();
  });

  it('draws a resolved row as a receipt that can still be taken back', async () => {
    serveDecisions([resolvedFixture('executed')]);
    render(<InThreadApprovals />);

    const receipt = await screen.findByTestId('approval-d-marcus');
    expect(receipt).toHaveAttribute('data-status', 'executed');
    expect(
      screen.getByText('Scheduler moved your 1:1 with Marcus to Thursday 9:30'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
  });

  /*
    Quiet ON SCREEN, and the second half of that sentence is the point. This
    test used to assert only the silence, which enshrined it: on a default
    deployment `/workspace` and the Today queue are flag-gated off, so this is
    the ONLY decision surface, and a failed first read with no signal anywhere
    leaves the reader with prose saying the agent is waiting and nothing to act
    on — this card's own dead end, on the error path.
  */
  it('stays quiet on screen when the read fails and nothing says a decision exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const read = vi
      .spyOn(workspaceApi, 'decisions')
      .mockRejectedValue(new Error('boom'));
    const { container } = render(<InThreadApprovals />);

    await settle();
    // Quiet is not silent — an operator can still find this, and the line is
    // also the proof the failure reached state before the two null checks ran.
    // Exactly one line, exactly one read: the counts are pinned rather than
    // merely non-zero. Be precise about what that catches. With `raised` at 0
    // there is a single error-bearing commit, so a component that logged once
    // per ERROR-BEARING render would still show one warn and sail through here
    // — that narrower bug belongs to the dedupe test below. What this count
    // catches is a component that logs on EVERY render, the `error === null`
    // mount render included.
    expect(read).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[decisions]');

    expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  /*
    TASK-311. THE DEDUPE IS THE ASSERTION, and this test could not make it.

    It used to `rerender` the component and check the count had not moved. That
    can never fail. The logging effect's deps are `[error]`
    (`InThreadApprovals.tsx`), so a re-render carrying the SAME error object does
    not run the effect at all — the count was pinned by React, not by the guard.
    Deleting `if (loggedError.current === key) return;` left the old version of
    this file 22/22 (re-confirmed while writing this), and TASK-311 measured the
    whole package still green at 1644/1644. A working guard had zero coverage,
    under the one test whose name claimed to be it.

    What actually exercises the guard is the component's own retry ladder. The
    hook holds a FRESH error object per failed read — that identity change is how
    it re-arms — so every rung re-runs this effect with a new object and an
    identical `kind:detail` key. Suppressing those is the guard's entire job, and
    an outage is exactly that shape: five reads, ONE line. With the guard gone
    this test sees 2 warns by the first rung and 4 by the end of the ladder, and
    goes red on the first of them.
  */
  it('logs a failed read even when it DOES surface it, and only once per failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const read = vi
      .spyOn(workspaceApi, 'decisions')
      .mockRejectedValue(new Error('boom'));
    // Before `render`, or the banner never appears and there is no "DOES
    // surface it" for the log to sit beside.
    decisionRaisedActions.raise();
    render(<InThreadApprovals />);

    await settle();
    expect(screen.getByText(DECISION_READ_FAILED_TITLE)).toBeInTheDocument();
    // TWO reads before a single timer has moved: the ambient one every mount
    // makes, and the one the raised frame kicks off. This pair is NOT what
    // exercises the guard, and saying otherwise is how a test starts
    // over-claiming again — both reads fail, but only the LATER one reaches
    // `setError`, so the effect runs once and this count is 1 with the guard or
    // without it. It is here as the baseline the retry is measured against.
    //
    // The reason is NOT React batching two commits, and the difference matters.
    // `useDecisionQueue.refresh` does `const id = ++readId.current` on entry, so
    // these two reads hold ids 1 and 2 before either promise settles; the
    // earlier rejection then hits `if (readId.current !== id) return` in the
    // catch and returns before `setError`. Its failure is DISCARDED by the
    // stale-read guard. That guard is load-bearing — see the header on `readId`
    // in `workspace-decisions.ts`, which is there so a slow first read cannot
    // clobber a fast refresh — so do not read this count as "React merged
    // them" and go simplify it away.
    expect(read).toHaveBeenCalledTimes(2);
    const after = warn.mock.calls.length;
    expect(after).toBe(1);

    // Rung one: a genuinely new read, a genuinely new failure, a new error
    // object behind it. Both assertions are needed — without the read count,
    // "the warn count did not move" is satisfied by nothing having happened,
    // which is precisely the vacuity this replaces.
    await tick(READ_RETRY_DELAYS_MS[0]!);
    expect(read).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.length).toBe(after);

    // And through the rest of the ladder, which is what an outage looks like
    // from here: five reads, ONE console line. Measured with the guard deleted,
    // the assertion above goes red at 2 — which is where vitest stops, so this
    // line never executes. The 4 is a property of the component, not a test
    // outcome: without the guard it would reach 4 warns here if execution
    // continued.
    for (const delay of READ_RETRY_DELAYS_MS.slice(1)) await tick(delay);
    expect(read).toHaveBeenCalledTimes(2 + READ_RETRY_DELAYS_MS.length);
    expect(warn.mock.calls.length).toBe(after);
  });

  it('speaks up when the read fails AND a live frame says something is waiting', async () => {
    vi.spyOn(workspaceApi, 'decisions').mockRejectedValue(new Error('boom'));
    decisionRaisedActions.raise();
    render(<InThreadApprovals />);

    /*
      Real timers here, because the point is a CLICK. Both budgets are widened
      off the 1000ms default: this component reads twice on mount and this
      package's suite has been measured several times slower than idle under CI
      load, which is enough to blow a one-second wait on a test with nothing
      wrong with it.
    */
    expect(
      await screen.findByText(DECISION_READ_FAILED_TITLE, undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });

    const readAgain = vi
      .spyOn(workspaceApi, 'decisions')
      .mockResolvedValue({ decisions: [decisionFixture()] });
    fireEvent.click(retry);
    expect(
      await screen.findByTestId('approval-d-marcus', undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(readAgain).toHaveBeenCalled();
    expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
  });

  /*
    TASK-274. Nothing here polls, so a failed read used to be the end of it: the
    list was re-read only when a frame landed, the thread changed, or somebody
    clicked. A blip while a hold was actually open therefore hid the card until
    the reader happened to act — and a person who can see nothing waiting on
    them has no reason to.

    The retry lives in `useConversationDecisions` and is pinned there. What
    these two hold is the part that is this component's call: the retry must not
    become a way around the frame gate, and the sentence on screen must only
    promise an attempt while one is actually coming.
  */
  describe('a failed read is no longer the end of it', () => {
    it('reads again on its own, and the screen stays quiet while it does', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ decisions: [decisionFixture()] });
      const { container } = render(<InThreadApprovals />);

      await settle();
      /*
        THE SILENCE IS NOT WEAKENED. With no live frame vouching for a hold,
        a failed read still puts nothing on screen — this fetch is ambient, and
        an error line keyed on the failure alone would hand approval copy to
        thousands of people who have no approvals. The retry is a second look,
        not a new claim.
      */
      expect(container.firstChild).toBeNull();
      expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);

      await tick(READ_RETRY_DELAYS_MS[0]!);

      // Nobody clicked, nobody switched threads, no frame landed. The hold is
      // on screen because the read came back by itself — which is the entire
      // point, and what "terminal until an unrelated user action" meant.
      expect(read).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('approval-d-marcus')).toBeInTheDocument();
      // Quiet on screen was never silent to an operator.
      expect(warn).toHaveBeenCalled();
    });

    it('promises another attempt only while one is coming', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers();
      vi.spyOn(workspaceApi, 'decisions').mockRejectedValue(new Error('boom'));
      // The frame is what makes this box sayable at all; without it the case
      // above applies and there is no sentence to get right.
      decisionRaisedActions.raise();
      render(<InThreadApprovals />);

      await settle();
      expect(screen.getByText(DECISION_READ_RETRYING)).toBeInTheDocument();
      expect(screen.queryByText(DECISION_READ_FAILED)).toBeNull();
      // Same action either way, and available now rather than after a back-off.
      expect(
        screen.getByRole('button', { name: 'Try again' }),
      ).toBeInTheDocument();

      // Past the whole ladder, however the attempts fall.
      const past = Math.max(...READ_RETRY_DELAYS_MS) + 1;
      for (let i = 0; i <= READ_RETRY_DELAYS_MS.length; i += 1) await tick(past);

      // The attempts are spent, so the sentence stops claiming them. A line
      // that went on saying "trying again" over a queue nothing is reading any
      // more is the unbacked promise this copy was held back for.
      expect(screen.queryByText(DECISION_READ_RETRYING)).toBeNull();
      expect(screen.getByText(DECISION_READ_FAILED)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Try again' }),
      ).toBeInTheDocument();
    });

    /*
      TASK-290. The register has to move with the sentence, and it did not.

      This box was neutral in BOTH states. Neutral is honest while an attempt is
      coming — the state resolves itself and nothing is asked of the reader —
      and it stops being honest the moment the budget is spent, because then the
      reader is in exactly the state a `TodayView` reader is in on their FIRST
      failure: a hold exists, we cannot read it, and nothing further happens
      until they click. `TodayView` draws that red (pinned at
      `TodayView.test.tsx`), and it draws it red on the first failure precisely
      because `useDecisionQueue` has no automatic retry to wait on. Same state,
      two colours, was the one genuine disagreement between the three surfaces.

      Both halves are asserted, so flattening the branch either way fails one of
      them. The rule that decides it is `lib/read-register.ts`.
    */
    it('goes red only once nothing further is coming', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers();
      vi.spyOn(workspaceApi, 'decisions').mockRejectedValue(new Error('boom'));
      decisionRaisedActions.raise();
      render(<InThreadApprovals />);

      await settle();
      // An attempt is genuinely on its way. Red would overstate a state that is
      // about to fix itself without the reader lifting a finger.
      expect(screen.getByText(DECISION_READ_RETRYING)).toBeInTheDocument();
      expect(screen.getByRole('alert').className).not.toContain('destructive');

      const past = Math.max(...READ_RETRY_DELAYS_MS) + 1;
      for (let i = 0; i <= READ_RETRY_DELAYS_MS.length; i += 1) await tick(past);

      // Budget spent: terminal until the reader acts, which is what red means.
      expect(screen.getByText(DECISION_READ_FAILED)).toBeInTheDocument();
      expect(screen.getByRole('alert').className).toContain('destructive');
      // The heading stays. It is evidenced by the live frame either way, and
      // the red is about the queue underneath it, not about the hold.
      expect(screen.getByText(DECISION_READ_FAILED_TITLE)).toBeInTheDocument();
    });

    /*
      The other kind keeps its own answer. A session that ran out is not a
      malfunction and no retry is armed for it, so the "nothing further is
      coming" clause must NOT drag it red — the exception is the reader's action
      being sign-in rather than repair.
    */
    it('never reddens a signed-out session, which has no retry either', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers();
      vi.spyOn(workspaceApi, 'decisions').mockRejectedValue(
        new WorkspaceApiError('workspace /decisions', 401),
      );
      render(<InThreadApprovals />);

      await settle();
      expect(screen.getByText(DECISION_SESSION_EXPIRED_TITLE)).toBeInTheDocument();
      expect(screen.getByRole('alert').className).not.toContain('destructive');
    });
  });

  /*
    TASK-276. One warning covered two facts that call for opposite outcomes: a
    read that FAILED, and a read that was REFUSED because the session ran out.
    `WorkspaceApiError` has carried `.status` since the Files tab needed it;
    `useDecisionQueue` flattened it to `e.message` and threw the status away, so
    the 401 survived only as text inside "workspace /decisions → 401".

    These tests pin the two apart at both ends: what an operator reads in the
    console, and what the person in front of the screen is asked to do.
  */
  describe('a session that ran out is not a blip', () => {
    function serve401() {
      return vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new WorkspaceApiError('/decisions', 401));
    }

    /*
      Not gated on a `decisionRaised` frame, and there is none here. That gate
      exists so an outage cannot put APPROVAL copy in front of people who have
      no approvals; the signed-out line makes no approval claim — it reports the
      reader's own session, which the 401 is direct evidence of. The blip line
      is still gated, which the 500 case below pins.
    */
    it('asks the reader to sign in, and never offers a retry that cannot work', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      serve401();
      render(<InThreadApprovals />);

      expect(
        await screen.findByText(DECISION_SESSION_EXPIRED_TITLE),
      ).toBeInTheDocument();
      expect(screen.getByText(DECISION_SESSION_EXPIRED)).toBeInTheDocument();
      // The blip copy asks people to try again. Every retry here returns the
      // same 401, so it is absent — and so is the title that would claim an
      // assistant is waiting, which a 401 is no evidence for.
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
    });

    it('starts sign-in when that button is pressed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.mocked(signInWithGoogle).mockClear();
      serve401();
      render(<InThreadApprovals />);

      fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
      expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    });

    it('tells an operator WHICH of the two happened', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const read = serve401();
      render(<InThreadApprovals />);

      await waitFor(() => expect(read).toHaveBeenCalled());
      await waitFor(() => expect(warn).toHaveBeenCalled());
      const line = String(warn.mock.calls[0]?.[0]);
      // The sentence names the cause. An operator who reads "could not read"
      // for a 401 goes hunting for a broken route; there is not one.
      expect(line).toContain('[decisions]');
      expect(line).toContain('session has expired');
      expect(line).not.toContain('could not read what is waiting for approval');
    });

    it('and says the other thing for a read that really did fail', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new WorkspaceApiError('/decisions', 500));
      render(<InThreadApprovals />);

      await waitFor(() => expect(read).toHaveBeenCalled());
      await waitFor(() => expect(warn).toHaveBeenCalled());
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain('could not read what is waiting for approval');
      expect(line).not.toContain('session has expired');
      // A 500 with no frame vouching for an approval stays quiet on screen —
      // that gate is untouched.
      expect(screen.queryByText(DECISION_SESSION_EXPIRED_TITLE)).toBeNull();
      expect(screen.queryByText(DECISION_READ_FAILED_TITLE)).toBeNull();
    });

    it('never prints the thrown message at the reader', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      serve401();
      const { container } = render(<InThreadApprovals />);

      await screen.findByText(DECISION_SESSION_EXPIRED_TITLE);
      expect(container.textContent).not.toContain('workspace /decisions');
      expect(container.textContent).not.toContain('401');
    });
  });

  it('the primary button reaches the approve route and applies the row it returns', async () => {
    serveDecisions([decisionFixture()]);
    const approve = vi
      .spyOn(workspaceApi, 'approveDecision')
      .mockResolvedValue({
        decision: resolvedFixture('executed'),
        executed: true,
        path: 'host-replays',
        error: null,
        pendingUntil: null,
      });

    render(<InThreadApprovals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith('d-marcus'));
    // The card became its own receipt — from the server's row, not a guess.
    await waitFor(() =>
      expect(screen.getByTestId('approval-d-marcus')).toHaveAttribute(
        'data-status',
        'executed',
      ),
    );
  });

  /*
    Review finding 5. A resolved row keeps its Undo for ten seconds, so this
    region renders with nothing open in it — and announcing "waiting for your
    approval" over something already answered tells a screen-reader user the
    opposite of the truth.
  */
  it('does not announce a wait when it is holding receipts only', async () => {
    serveDecisions([resolvedFixture('executed')]);
    render(<InThreadApprovals />);

    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Recent approvals' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: 'Waiting for your approval' })).toBeNull();
  });

  /*
    Review finding: the live region must not contain the Undo countdown.

    `aria-live` used to sit on the whole cluster, which announced arrival — and
    also announced every mutation inside it. A settled receipt inside its undo
    window re-renders `Undo | Ns` once a SECOND off `useDecisionClock`, so a
    screen-reader user got up to ten announcements per resolved decision and the
    one that mattered was buried. The announcer is now a separate node holding
    one stable sentence.
  */
  it('keeps the ticking undo countdown out of the live region', async () => {
    serveDecisions([resolvedFixture('executed')]);
    const { container } = render(<InThreadApprovals />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument(),
    );

    const live = container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    // The one live node holds a sentence, never a card and never a counter.
    expect(live[0]!.querySelector('button')).toBeNull();
    expect(live[0]!.textContent ?? '').not.toMatch(/\d+s/);
  });

  it('announces a wait when something really is open', async () => {
    serveDecisions([decisionFixture()]);
    render(<InThreadApprovals />);

    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Waiting for your approval' }),
      ).toBeInTheDocument(),
    );
  });
});
