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
import { renderHook, waitFor } from '@testing-library/react';
import { useConversationDecisions, SETTLED_CAP } from '../conversation-decisions';
import { decisionRaisedActions } from '../decision-raised-store';
import { workspaceApi, type Decision } from '../workspace-api';
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
});
