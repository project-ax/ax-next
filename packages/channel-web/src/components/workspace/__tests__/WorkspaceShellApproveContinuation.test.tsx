/**
 * TASK-542 — approving a hold in the agent's thread streams the continuation.
 *
 * An approval delivered to a warm agent starts a NEW turn server-side, and the
 * approve response names it: `{ path: 'agent-executes', streamReqId }`. The
 * TASK-358 walk measured the workspace thread never opening that stream — the
 * agent's answer existed on the server ~20s after approve and was not on
 * screen at 40, 58 or 63s; it appeared only after an unrelated send. Chat had
 * this since TASK-278; `WorkspaceShell` called `useDecisionQueue()` with no
 * `onDecisionApproved`, so the id went nowhere.
 *
 * Driven through the REAL shell, queue and `AgentView`, with only the wire
 * mocked, so the wiring itself is what is under test — a harness that wired
 * the hook for us would pass on the unfixed shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  workspaceApi,
  type AgentDetail,
  type StreamHandlers,
  type ThreadMessage,
} from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { resetDraftsForTest } from '@/lib/workspace-draft-store';
import { continuationActions } from '@/lib/continuation-actions';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';
import { decisionFixture, resolvedFixture } from './decision-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      decision: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const decisionMock = vi.mocked(workspaceApi.decision);
const approveMock = vi.mocked(workspaceApi.approveDecision);
const streamMock = vi.mocked(workspaceApi.streamReply);

const user = { id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' as const };

const QUILL = {
  id: 'scheduler',
  name: 'Quill',
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const open = decisionFixture(); // agent `scheduler`, conversation `c1`
const pointer: ThreadMessage = { kind: 'approval', id: `decision-${open.id}`, decisionId: open.id };
const asked: ThreadMessage = { kind: 'user', id: 't1', text: 'move my 1:1' };
const CONTINUATION = 'Approved and done! Your 1:1 is on Thursday.';

function detail(thread: ThreadMessage[], conversationId = 'c1'): AgentDetail {
  return {
    agent: QUILL,
    conversationId,
    thread,
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
      learned: { status: 'unavailable', docs: [] },
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

function answerApprove(streamReqId: string | null, over: Partial<typeof open> = {}) {
  approveMock.mockResolvedValue({
    decision: resolvedFixture('executed', over),
    executed: false,
    path: 'agent-executes',
    error: null,
    pendingUntil: null,
    streamReqId,
  });
}

/** The handlers the view handed `streamReply` for `reqId`, or undefined. */
function handlersFor(reqId: string): StreamHandlers | undefined {
  const call = streamMock.mock.calls.find(([id]) => id === reqId);
  return call?.[1];
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  continuationActions.reset();
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [QUILL] });
  agentMock.mockReset();
  agentMock.mockResolvedValue(detail([asked, pointer]));
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [open] });
  decisionMock.mockReset();
  decisionMock.mockImplementation(async (id: string) => ({
    decision: resolvedFixture('executed', { id }),
  }));
  approveMock.mockReset();
  streamMock.mockReset();
  // Held open until the test drives it, like a real long-running turn.
  streamMock.mockImplementation(() => new Promise<void>(() => undefined));
  resetDraftsForTest();
});

afterEach(() => {
  cleanup();
  resetDraftsForTest();
  continuationActions.reset();
});

describe('approve in the agent thread → the continuation streams live (TASK-542)', () => {
  it('opens the returned stream, renders it below the receipt, and keeps focus on the receipt', async () => {
    renderAt('/workspace/agents/scheduler');
    const yes = await screen.findByRole('button', { name: open.primaryLabel });

    answerApprove('req-cont-1');
    yes.focus();
    fireEvent.click(yes);
    await settle();

    // THE BUG: on main nothing ever asks for this stream.
    expect(streamMock).toHaveBeenCalledWith('req-cont-1', expect.anything());
    const handlers = handlersFor('req-cont-1')!;

    const outcome = screen.getByTestId(`approval-outcome-${open.id}`);
    expect(document.activeElement).toBe(outcome);

    act(() => handlers.onText(CONTINUATION));
    await settle();

    const live = screen.getByText(CONTINUATION);
    expect(outcome.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The receipt keeps focus while the continuation streams (TASK-536).
    expect(document.activeElement).toBe(outcome);
    // And no user bubble was invented for a turn the person did not send.
    expect(screen.getAllByText('move my 1:1')).toHaveLength(1);

    // The turn finishes: the durable re-read carries the answer, and the
    // receipt survives it (keepAnsweredApprovals) with its focus.
    decisionsMock.mockResolvedValue({ decisions: [] });
    agentMock.mockResolvedValue(
      detail([asked, { kind: 'agent', id: 't2', text: CONTINUATION, at: new Date().toISOString() }]),
    );
    act(() => handlers.onDone());
    await settle();

    expect(screen.getAllByText(CONTINUATION)).toHaveLength(1);
    expect(screen.getByTestId(`approval-outcome-${open.id}`)).toBe(outcome);
    expect(document.activeElement).toBe(outcome);
  });

  it('opens nothing when the approve answers no streamReqId', async () => {
    renderAt('/workspace/agents/scheduler');
    const yes = await screen.findByRole('button', { name: open.primaryLabel });

    answerApprove(null);
    fireEvent.click(yes);
    await settle();

    expect(screen.getByTestId(`approval-outcome-${open.id}`)).toBeTruthy();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('opens nothing when the decision belongs to another conversation than the one on screen', async () => {
    // The thread on screen is c-now; the card's row says c1 (an older turn).
    agentMock.mockResolvedValue(detail([asked, pointer], 'c-now'));
    renderAt('/workspace/agents/scheduler');
    const yes = await screen.findByRole('button', { name: open.primaryLabel });

    answerApprove('req-cont-1');
    fireEvent.click(yes);
    await settle();

    expect(streamMock).not.toHaveBeenCalled();
  });

  it('approving from Today, with no thread mounted, opens nothing and says nothing', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      renderAt('/workspace');
      // Today's rows start collapsed; the question itself is the toggle.
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(open.summary.slice(0, 20)) }));
      const yes = await screen.findByRole('button', { name: open.primaryLabel });

      answerApprove('req-cont-1');
      fireEvent.click(yes);
      await settle();

      expect(approveMock).toHaveBeenCalledWith(open.id);
      expect(streamMock).not.toHaveBeenCalled();
      expect(warn.mock.calls.some(([m]) => String(m).includes('[continuation]'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
