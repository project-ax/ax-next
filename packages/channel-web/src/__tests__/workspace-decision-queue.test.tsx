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
import { act, renderHook } from '@testing-library/react';
import type { Decision } from '@/lib/workspace-types';
import { UNDO_WINDOW_MS } from '@/lib/workspace-types';
import { undoSecondsLeft } from '@/components/workspace/decision-copy';

const listDecisions = vi.fn();
const readDecision = vi.fn();
const approveDecision = vi.fn();
const dismissDecision = vi.fn();
const undoDecision = vi.fn();

vi.mock('../lib/workspace-api', () => ({
  workspaceApi: {
    decisions: (...a: unknown[]) => listDecisions(...a),
    decision: (...a: unknown[]) => readDecision(...a),
    approveDecision: (...a: unknown[]) => approveDecision(...a),
    dismissDecision: (...a: unknown[]) => dismissDecision(...a),
    undoDecision: (...a: unknown[]) => undoDecision(...a),
  },
}));

import { useDecisionQueue } from '../lib/workspace-decisions';
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
});
