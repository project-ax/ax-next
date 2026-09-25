/**
 * A RECEIPT MUST OUTLIVE THE RE-READ THAT NO LONGER LISTS IT (TASK-509).
 *
 * Found by the TASK-358 walk. Answering a consent INSIDE the agent's thread
 * put focus on the receipt (TASK-427, t+218ms) — and then ~0.6s later the
 * whole `ApprovalCard` unmounted and focus fell to `<body>`. The same answer
 * given from Today kept its receipt, and its live `Undo · Ns`, for 60s.
 *
 * The cause is one line of arithmetic between two facts:
 *
 *   - `GET /api/workspace/decisions` lists only OPEN rows (`decisions:list`'s
 *     default status set). A resolved row is, by design, not in it.
 *   - Approving in-thread resumes the turn, and the thread's `onDone` /
 *     `onDecisionRaised` both call the shell's `queue.refresh()`.
 *
 * So the refresh that follows every in-thread answer replaced the queue with a
 * list that does not contain the row just answered, the card looked its
 * decision up by id, found nothing, and rendered `null`. Today only survived
 * because nothing on Today triggers that refresh — it was never retaining
 * anything of its own.
 *
 * The fix is in the one place both surfaces read from: `useDecisionQueue`'s
 * refresh keeps a just-resolved row the server stopped listing. These tests
 * drive the REAL hook through a mocked transport, so the re-read is the actual
 * code path that dropped the card, not a harness re-enacting it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-types';
import { JUST_RESOLVED_MS } from '@/lib/workspace-types';

const listDecisions = vi.fn();
const readDecision = vi.fn();
const approveDecision = vi.fn();
const dismissDecision = vi.fn();
const undoDecision = vi.fn();

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

import { useDecisionQueue, type DecisionQueue } from '../lib/workspace-decisions';
import { AgentConversation } from '../components/workspace/AgentConversation';
import {
  decisionFixture,
  resolvedFixture,
} from '../components/workspace/__tests__/decision-fixture';

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const quill: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/** A page's worth of tabbables above the thread, so `<body>` is far from Undo. */
function Decoys(): ReactNode {
  return (
    <nav>
      {['Home', 'Agents', 'Today', 'Files'].map((n) => (
        <button key={n} type="button">
          {n}
        </button>
      ))}
    </nav>
  );
}

/**
 * The workspace thread, fed by the real queue — the shape `WorkspaceShell`
 * wires: one `useDecisionQueue`, its `decisions` handed to the thread.
 */
function Thread({ expose }: { expose: (q: DecisionQueue) => void }) {
  const q = useDecisionQueue();
  expose(q);
  const open = decisionFixture();
  return (
    <div>
      <Decoys />
      <AgentConversation
        agent={quill}
        thread={[{ kind: 'approval', id: 'm-approval', decisionId: open.id }]}
        conversationId="c1"
        decisions={q.decisions}
        readOnly={false}
        onSend={vi.fn()}
        onApprove={q.approve}
        onDismiss={q.dismiss}
        onUndo={q.undo}
        busyIds={q.busyIds}
        notices={q.notices}
        approvalRead="ok"
        onRetryApprovals={vi.fn()}
        grants={[]}
        onGrantResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
      />
    </div>
  );
}

beforeEach(() => {
  listDecisions.mockReset();
  readDecision.mockReset();
  approveDecision.mockReset();
  dismissDecision.mockReset();
  undoDecision.mockReset();
  // Nothing consumed it yet: every poll hands back the same resolved row.
  readDecision.mockImplementation(async (id: string) => ({
    decision: resolvedFixture('executed', { id }),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('in-thread receipt — survives the post-answer queue refresh (TASK-509)', () => {
  it('keeps the card mounted, focus on the receipt, and Undo working after the refresh', async () => {
    const open = decisionFixture();
    listDecisions.mockResolvedValue({ decisions: [open] });
    let queue!: DecisionQueue;
    render(<Thread expose={(q) => (queue = q)} />);
    await settle();

    const justApproved = resolvedFixture('executed');
    approveDecision.mockResolvedValue({
      decision: justApproved,
      executed: true,
      path: null,
      error: null,
      pendingUntil: null,
      streamReqId: null,
    });

    const yes = screen.getByRole('button', { name: open.primaryLabel });
    yes.focus();
    fireEvent.click(yes);
    await settle();

    // TASK-427's half, already correct before this card: focus is on the receipt.
    const outcome = screen.getByTestId(`approval-outcome-${open.id}`);
    expect(document.activeElement).toBe(outcome);

    // The turn resumes and finishes; the shell re-reads the queue. The server's
    // open-only list no longer carries the row we just answered.
    listDecisions.mockResolvedValue({ decisions: [] });
    await act(async () => {
      await queue.refresh();
    });

    // THE BUG: on `main` the card is gone here and activeElement is <body>.
    expect(screen.getByTestId(`approval-outcome-${open.id}`)).toBe(outcome);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(outcome);

    // And the advertised Undo is reachable and does something.
    undoDecision.mockResolvedValue({ decision: decisionFixture(), undone: true });
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await settle();
    expect(undoDecision).toHaveBeenCalledWith(open.id);
    // Undone: the question is back, with its buttons.
    expect(screen.getByRole('button', { name: open.primaryLabel })).toBeTruthy();
  });
});

describe('useDecisionQueue.refresh — what a re-read keeps and what it drops', () => {
  async function mount(rows: Decision[]) {
    listDecisions.mockResolvedValue({ decisions: rows });
    const handle = renderHook(() => useDecisionQueue());
    await settle();
    return handle;
  }

  it('keeps a row resolved moments ago that the server no longer lists', async () => {
    const resolved = resolvedFixture('dismissed');
    const { result } = await mount([resolved]);

    listDecisions.mockResolvedValue({ decisions: [] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.decisions.map((d) => d.id)).toEqual([resolved.id]);
    expect(result.current.decisions[0]!.status).toBe('dismissed');
  });

  it('drops an OPEN row the server no longer lists — it was answered elsewhere', async () => {
    // Keeping this one would offer buttons for a question that is closed.
    const open = decisionFixture();
    const { result } = await mount([open]);

    listDecisions.mockResolvedValue({ decisions: [] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.decisions).toEqual([]);
  });

  it('drops a resolved row once it is older than JUST_RESOLVED_MS', async () => {
    const old = resolvedFixture('executed', {
      resolvedAt: new Date(Date.now() - JUST_RESOLVED_MS - 1).toISOString(),
    });
    const { result } = await mount([old]);

    listDecisions.mockResolvedValue({ decisions: [] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.decisions).toEqual([]);
  });

  it("prefers the server's copy of a row it still lists, and adds new rows", async () => {
    const resolved = resolvedFixture('executed');
    const { result } = await mount([resolved]);

    const serverCopy = { ...resolved, undoable: false };
    const fresh = decisionFixture({ id: 'd-new' });
    listDecisions.mockResolvedValue({ decisions: [fresh, serverCopy] });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.decisions).toEqual([fresh, serverCopy]);
  });
});
