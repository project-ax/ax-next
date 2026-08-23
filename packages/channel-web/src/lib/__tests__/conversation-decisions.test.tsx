/**
 * `useConversationDecisions()` — the narrowing, and nothing but the narrowing.
 *
 * The hook owns no decision logic on purpose, so what is actually worth testing
 * is the four things it DOES decide: which rows belong to this thread, which of
 * them are still questions, what order they come in, and how many receipts are
 * allowed to stay on a fixed cluster that grows upward off the top of the
 * screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useConversationDecisions,
  READ_RETRY_DELAYS_MS,
  SETTLED_CAP,
} from '../conversation-decisions';
import { decisionRaisedActions } from '../decision-raised-store';
import { workspaceApi, WorkspaceApiError, type Decision } from '../workspace-api';
import { decisionFixture } from '@/components/workspace/__tests__/decision-fixture';

let mockConversationId: string | null = 'c1';
vi.mock('../use-conversation-id', () => ({
  useConversationId: () => mockConversationId,
  setActiveConversationId: () => undefined,
}));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** A resolved row with no undo left, so nothing on it runs a timer. */
const settledRow = (id: string, resolvedAt: string): Decision =>
  decisionFixture({ id, status: 'dismissed', resolvedAt, undoable: false });

function serve(decisions: Decision[]) {
  return vi.spyOn(workspaceApi, 'decisions').mockResolvedValue({ decisions });
}

describe('useConversationDecisions', () => {
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

  it('keeps only this conversation, oldest question first', async () => {
    serve([
      decisionFixture({ id: 'd-mine-new', createdAt: minutesAgo(1) }),
      decisionFixture({ id: 'd-theirs', conversationId: 'c2' }),
      decisionFixture({ id: 'd-mine-old', createdAt: minutesAgo(30) }),
    ]);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(result.current.open).toHaveLength(2));
    expect(result.current.open.map((d) => d.id)).toEqual([
      'd-mine-old',
      'd-mine-new',
    ]);
    expect(result.current.settled).toEqual([]);
  });

  it('splits questions from receipts by the shared outcome helper', async () => {
    serve([
      decisionFixture({ id: 'd-pending', status: 'pending' }),
      decisionFixture({ id: 'd-stale', status: 'stale' }),
      settledRow('d-dismissed', minutesAgo(2)),
      decisionFixture({ id: 'd-expired', status: 'expired', resolvedAt: minutesAgo(3) }),
    ]);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(result.current.open).toHaveLength(2));
    // `stale` is still a question — it asks again with a warning, it is not a
    // receipt — so it belongs in `open` next to `pending`.
    expect(result.current.open.map((d) => d.id).sort()).toEqual([
      'd-pending',
      'd-stale',
    ]);
    expect(result.current.settled.map((d) => d.id).sort()).toEqual([
      'd-dismissed',
      'd-expired',
    ]);
  });

  it(`keeps at most ${SETTLED_CAP} receipts — the most recent ones`, async () => {
    serve([
      settledRow('d-1', minutesAgo(50)),
      settledRow('d-2', minutesAgo(40)),
      settledRow('d-3', minutesAgo(30)),
      settledRow('d-4', minutesAgo(20)),
      settledRow('d-5', minutesAgo(10)),
    ]);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(result.current.settled).toHaveLength(SETTLED_CAP));
    // The three newest, back in thread order (newest closest to the composer).
    expect(result.current.settled.map((d) => d.id)).toEqual(['d-3', 'd-4', 'd-5']);
  });

  it('has no rows at all before the first message mints a conversation', async () => {
    mockConversationId = null;
    const read = serve([decisionFixture(), settledRow('d-done', minutesAgo(1))]);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(result.current.open).toEqual([]);
    expect(result.current.settled).toEqual([]);
    expect(result.current.conversationId).toBeNull();
  });

  it('re-reads the list when a decisionRaised frame lands, but not on mount', async () => {
    const read = serve([]);
    renderHook(() => useConversationDecisions());

    // One read on mount — `useDecisionQueue` already does it, so the raise
    // effect must not fire a duplicate at 0.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    read.mockResolvedValue({ decisions: [decisionFixture()] });
    decisionRaisedActions.raise();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('drops the raised evidence and re-reads when the conversation changes', async () => {
    const read = serve([]);
    const { rerender, result } = renderHook(() => useConversationDecisions());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    decisionRaisedActions.raise();
    await waitFor(() => expect(result.current.raised).toBe(1));

    mockConversationId = 'c2';
    rerender();

    // Evidence from thread A must not vouch for thread B, and B is re-read
    // rather than trusting whatever A left in the list.
    await waitFor(() => expect(result.current.raised).toBe(0));
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  /*
    Review finding 4. The first turn mints its conversation, so the id goes
    `null -> c1` — and a `decisionRaised` frame for c1 can land fractionally
    BEFORE `useConversationId` flips, because both come out of the same round
    trip. Treating that step as "switched threads" would throw away evidence
    that belongs to the thread we just arrived in, and a failed read would then
    render nothing on the only surface that could have said so.
  */
  it('keeps evidence when the FIRST conversation is minted (null to c1)', async () => {
    mockConversationId = null;
    const read = serve([]);
    const { rerender, result } = renderHook(() => useConversationDecisions());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    decisionRaisedActions.raise();
    await waitFor(() => expect(result.current.raised).toBe(1));

    mockConversationId = 'c1';
    rerender();

    // Still 1: this is arrival, not a switch away from anything.
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(result.current.raised).toBe(1);
  });

  /*
    Review finding 2. The cap trims history; Undo is not history. On a default
    deployment `/workspace` and the activity feed are flag-gated off, so a
    receipt capped off this list has nowhere else to be — and capping away a row
    the SERVER still says is undoable would silently shorten the grace period on
    the fourth approval inside ten seconds.
  */
  /*
    A malformed body used to THROW out of `useDecisionQueue` during render:
    `setDecisions(undefined)` landed in state, and the undo-window `watchedKey`
    calls `.filter` on it on the very next render. That was survivable while the
    only caller was the flag-gated `/workspace`; mounting this on the default
    `/` chat surface would have blanked the chat for every user whenever the
    decisions route answered with a shape we could not read.

    It must also not be reported as an EMPTY QUEUE — "nothing is waiting on you"
    is the most reassuring claim this product makes, and it may only be made
    when we actually read the list.
  */
  it('treats a body with no decisions array as a failed read, not an empty queue', async () => {
    /*
      Goes through the REAL `workspaceApi`, mocking `fetch` rather than the
      client method, because the shape guard lives at that boundary — stubbing
      `workspaceApi.decisions` would step over the very thing under test and
      assert a state production can no longer reach.

      What this pins end to end: a 200 with the wrong body surfaces as a failed
      read here, and never as "nothing is waiting on you".
    */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.open).toEqual([]);
    expect(result.current.settled).toEqual([]);
  });

  it('never caps away a receipt that can still be taken back', async () => {
    // Four approvals inside the same ten-second window, and the one that can
    // still be taken back is the OLDEST — so a plain most-recent-three cap
    // sorts it into fourth place and drops it. That is the whole risk.
    const secondsAgo = (n: number) =>
      new Date(Date.now() - n * 1000).toISOString();
    serve([
      decisionFixture({
        id: 'd-oldest-undoable',
        status: 'executed',
        resolvedAt: secondsAgo(9),
        undoable: true,
      }),
      settledRow('d-2', secondsAgo(1)),
      settledRow('d-3', secondsAgo(2)),
      settledRow('d-4', secondsAgo(3)),
    ]);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(result.current.settled.length).toBeGreaterThan(0));
    const ids = result.current.settled.map((d) => d.id);
    expect(ids).toContain('d-oldest-undoable');
    // The plain receipts are still capped — only the live undo is exempt.
    expect(ids.filter((id) => id !== 'd-oldest-undoable')).toHaveLength(
      SETTLED_CAP,
    );
  });

  /*
    The exemption keys on `undoSecondsLeft() > 0`, not on the raw `undoable`
    flag. `undoable` is the server's "could this be taken back AT ALL" and
    carries no clock — an `approved-pending-agent` row stays `undoable` for as
    long as its agent takes to re-run. `ApprovalCard` draws no Undo button for
    those, so exempting them would stack buttonless receipts in a fixed cluster
    that grows upward and defeat the cap outright.
  */
  it('caps rows that are undoable but whose clock has run out', async () => {
    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    serve([
      decisionFixture({
        id: 'd-stale-undoable',
        status: 'approved-pending-agent',
        resolvedAt: longAgo,
        undoable: true,
      }),
      settledRow('d-2', minutesAgo(1)),
      settledRow('d-3', minutesAgo(2)),
      settledRow('d-4', minutesAgo(3)),
    ]);
    const { result } = renderHook(() => useConversationDecisions());

    await waitFor(() => expect(result.current.settled.length).toBeGreaterThan(0));
    expect(result.current.settled).toHaveLength(SETTLED_CAP);
    expect(result.current.settled.map((d) => d.id)).not.toContain(
      'd-stale-undoable',
    );
  });

  /*
    TASK-274. A failed read was TERMINAL. Nothing on this surface polls — the
    list is fetched once and afterwards re-read only when a `decisionRaised`
    frame lands, the thread changes, or somebody clicks — so a blip while a hold
    was genuinely open kept the card off the screen until the reader happened to
    do something else, which is exactly what a person with no visible approval
    has no reason to do.

    These pin the mechanism (it fires, it is bounded, it knows what not to
    retry). What a failed read is allowed to SAY is `InThreadApprovals`' call
    and is pinned there — unchanged, and deliberately so.
  */
  describe('a failed read tries itself again', () => {
    /** Let a read settle without moving any retry timer. */
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    /** Longer than the whole ladder, so "and then it stops" is a real claim. */
    const PAST_THE_END_MS =
      READ_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 60_000;

    it('re-reads on its own, and gives up after a bounded number of tries', async () => {
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useConversationDecisions());

      await settle();
      // Nobody has done anything yet: this is the mount read alone.
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.current.retrying).toBe(true);

      for (const [i, delay] of READ_RETRY_DELAYS_MS.entries()) {
        await tick(delay);
        expect(read).toHaveBeenCalledTimes(i + 2);
      }

      // And then it stops. An ambient read on the default surface must not turn
      // into a poll that multiplies an outage by every open tab.
      await tick(PAST_THE_END_MS);
      expect(read).toHaveBeenCalledTimes(READ_RETRY_DELAYS_MS.length + 1);
      // It also stops CLAIMING to try, so the surface can stop saying so.
      expect(result.current.retrying).toBe(false);
    });

    it('puts the rows up when a retry succeeds, with nobody having acted', async () => {
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ decisions: [decisionFixture()] });
      const { result } = renderHook(() => useConversationDecisions());

      await settle();
      expect(result.current.open).toEqual([]);

      await tick(READ_RETRY_DELAYS_MS[0]!);
      // The hold is on screen because the queue re-read itself — no frame, no
      // thread switch, no click. That is the whole card.
      expect(result.current.open.map((d) => d.id)).toEqual(['d-marcus']);
      // Two reads: the one that failed and the one that fixed it. Nothing else
      // fired, which is what "with nobody having acted" has to mean.
      expect(read).toHaveBeenCalledTimes(2);
      expect(result.current.error).toBeNull();
      expect(result.current.retrying).toBe(false);
    });

    it('does not let a read somebody else asked for spend one of its attempts', async () => {
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useConversationDecisions());

      await settle();
      expect(read).toHaveBeenCalledTimes(1);

      // `Try again`, or a `decisionRaised` frame, while the first automatic
      // attempt is still waiting. It re-reads — it always did — and the timer
      // it cancels was never an attempt, so it costs nothing.
      await act(async () => {
        await result.current.refresh();
      });
      expect(read).toHaveBeenCalledTimes(2);

      // The ladder still has every one of its rungs. Counting a cancelled
      // timer would let three clicks exhaust a retry that never fired once.
      for (const [i, delay] of READ_RETRY_DELAYS_MS.entries()) {
        await tick(delay);
        expect(read).toHaveBeenCalledTimes(i + 3);
      }
    });

    /*
      The other direction of the same contract, and the one the test above
      cannot see. It clicks BEFORE any attempt has fired, so a budget that
      wrongly refilled on a click would still produce the same read count. This
      one clicks in the MIDDLE, with attempts already behind it: refill and
      no-refill part company there.
    */
    it('does not let a click in the middle of an outage buy three more attempts', async () => {
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useConversationDecisions());

      await settle();
      await tick(READ_RETRY_DELAYS_MS[0]!);
      await tick(READ_RETRY_DELAYS_MS[1]!);
      // The mount read plus two automatic attempts. One rung left.
      expect(read).toHaveBeenCalledTimes(3);

      await act(async () => {
        await result.current.refresh();
      });
      expect(read).toHaveBeenCalledTimes(4);

      // Long enough for a refilled ladder to run end to end.
      const past = Math.max(...READ_RETRY_DELAYS_MS) + 1;
      for (let i = 0; i <= READ_RETRY_DELAYS_MS.length; i += 1) await tick(past);

      // Five: the mount read, two automatic attempts, the click, and the ONE
      // rung that was still owed. The budget belongs to the outage — a person
      // leaning on the button cannot turn it into a poll.
      expect(read).toHaveBeenCalledTimes(5);
      expect(result.current.retrying).toBe(false);
    });

    it('never retries a session that ran out — every attempt is the same 401', async () => {
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new WorkspaceApiError('/decisions', 401));
      renderHook(() => useConversationDecisions());

      await settle();
      await tick(PAST_THE_END_MS);
      // One read, and no promise of another: the reader has to sign in, and
      // three more refusals would only delay them being told so.
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('does not spend its attempts before there is a conversation to show them in', async () => {
      mockConversationId = null;
      vi.useFakeTimers();
      const read = vi
        .spyOn(workspaceApi, 'decisions')
        .mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useConversationDecisions());

      await settle();
      await tick(PAST_THE_END_MS);
      // With no conversation this hook returns `open: []` whatever the queue
      // holds, so a retry here could not put anything on screen — and the id is
      // null on every reload until the first click or sent message. Spending
      // the budget there would leave none for the window that matters.
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.current.retrying).toBe(false);
    });
  });
});
