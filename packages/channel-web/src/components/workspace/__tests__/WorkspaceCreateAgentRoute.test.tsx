/**
 * The workspace's create-an-agent door, and the kickoff that survives it
 * (TASK-249).
 *
 * `WorkspaceSidebar` renders a "New agent…" row only when `onCreateAgent` is
 * supplied — same prop-gated shape, and the same reason, as the Settings
 * entry `WorkspaceSettingsRoute.test.tsx` pins. These tests pin the thread
 * shell → sidebar → click, not the existence of a prop: a test that only
 * checked the prop would pass on a rail that accepted the callback and
 * dropped it.
 *
 * The other half of the card is the kickoff: a freshly-bootstrapped agent
 * gets a first message sent FOR it, through `WorkspaceShell`'s own
 * `startTurn` (not `bootstrapKickoff`, which only the chat runtime can
 * reach — see `lib/bootstrap-kickoff.ts`'s header). A failed kickoff must
 * still land the reader on the agent, and must say something went wrong
 * rather than staying quiet about it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { toastActions } from '@/lib/toast-store';
import { KICKOFF_TEXT } from '@/lib/bootstrap-kickoff';
import { WorkspaceShell, type WorkspaceShellProps } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      // TASK-373 — the shell's mount read-back; nothing here raises a grant.
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      // `AgentView` streams the kickoff reply once it mounts; a no-op
      // resolve is enough — these tests assert on the send and the route,
      // not on how the reply renders.
      streamReply: vi.fn(async () => {}),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const agentMock = vi.mocked(workspaceApi.agent);
const sendMessageMock = vi.mocked(workspaceApi.sendMessage);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

/** Enough of `AgentDetail` for `AgentView` to mount without throwing. */
function agentDetailFixture(id: string) {
  return {
    agent: {
      id,
      name: 'New agent',
      state: 'resting' as const,
      now: null,
      counter: null,
      startedAt: null,
      stoppedReason: null,
    },
    conversationId: 'c1',
    thread: [],
    decisions: { status: 'ok' as const },
    past: [],
    memory: [],
  };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/workspace');
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [] });
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  agentMock.mockReset();
  agentMock.mockResolvedValue(agentDetailFixture('a-new'));
  sendMessageMock.mockReset();
  // Spy rather than mock the implementation, so the real store still
  // updates (nothing here reads it back) — restored below so the call
  // count from one test can never leak into the next.
  vi.spyOn(toastActions, 'error');
});

afterEach(() => {
  vi.restoreAllMocks();
  toastActions.reset();
});

function renderShell(props: WorkspaceShellProps = {}) {
  return render(
    <UserProvider value={user}>
      <WorkspaceShell {...props} />
    </UserProvider>,
  );
}

describe('workspace create-agent door', () => {
  /**
   * VACUITY: against unfixed code (no `onCreateAgent` prop on
   * `WorkspaceShell`, so it is never threaded to the sidebar), the "New
   * agent…" row never renders, `screen.findByRole` for it times out, and this
   * test goes red. It only goes green once the shell actually forwards the
   * callback through to the sidebar's click handler.
   */
  it('the "New agent…" row reaches the app, through the sidebar', async () => {
    const onCreateAgent = vi.fn();
    renderShell({ onCreateAgent });

    const row = await screen.findByRole('button', { name: /New agent/ });
    fireEvent.click(row);

    await waitFor(() => expect(onCreateAgent).toHaveBeenCalledTimes(1));
  });

  /**
   * Vacuity guard for the test above — passes BY DESIGN whether or not
   * `onCreateAgent` is wired through `WorkspaceShell`, because the row is
   * deliberately prop-gated in `WorkspaceSidebar` and this simply confirms
   * that gating. It is the inverse of `WorkspaceSettingsRoute.test.tsx`'s
   * guard, whose entry renders unconditionally: here, the absence IS the
   * correct behavior, so this test's job is to prove test 1 was actually
   * exercising the wiring rather than a row that shows up regardless.
   */
  it('with no onCreateAgent, the row is absent', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Today' });
    expect(
      screen.queryByRole('button', { name: /New agent/ }),
    ).not.toBeInTheDocument();
  });

  /**
   * VACUITY: against unfixed code there is no `kickoffAgentId` prop on
   * `WorkspaceShell` and no effect to consume it, so `sendMessage` is never
   * called, the URL never moves, and `onKickoffConsumed` never fires. This
   * test goes red until the effect exists and actually sends through
   * `startTurn`.
   */
  it('a kickoffAgentId sends the bootstrap kickoff and opens the agent', async () => {
    sendMessageMock.mockResolvedValue({ reqId: 'r1', conversationId: 'c1' });
    const onKickoffConsumed = vi.fn();
    const { rerender } = renderShell({
      kickoffAgentId: 'a-new',
      onKickoffConsumed,
    });

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock).toHaveBeenCalledWith({
      agentId: 'a-new',
      conversationId: null,
      text: KICKOFF_TEXT,
    });
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-new'),
    );
    expect(onKickoffConsumed).toHaveBeenCalledTimes(1);

    // A re-render with the SAME kickoffAgentId must not resend it.
    rerender(
      <UserProvider value={user}>
        <WorkspaceShell
          kickoffAgentId="a-new"
          onKickoffConsumed={onKickoffConsumed}
        />
      </UserProvider>,
    );
    await waitFor(() => {
      // Give any errant re-fire a chance to land before asserting it didn't.
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
    expect(onKickoffConsumed).toHaveBeenCalledTimes(1);
  });

  /**
   * VACUITY: against unfixed code, same as above — no effect exists at all,
   * so a rejecting `sendMessage` cannot be observed either way, `pathname`
   * never changes, and no toast is raised. This test goes red until the
   * effect both sends AND handles the rejection by navigating anyway and
   * surfacing a toast.
   */
  it('a failed kickoff still opens the agent, and raises a toast', async () => {
    sendMessageMock.mockRejectedValue(new Error('boom'));
    renderShell({ kickoffAgentId: 'a-new' });

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-new'),
    );
    await waitFor(() => expect(toastActions.error).toHaveBeenCalledTimes(1));
  });

  /**
   * The SECOND passes-either-way guard in this file, and it is declared as one
   * (review finding: the file's vacuity accounting had named only the row
   * one). It is red on neither the unfixed code — where no effect exists — nor
   * the fixed code, where `if (!kickoffAgentId) return` handles it. Its job is
   * the same as the row guard's: it makes the positive kickoff test above mean
   * something, by ruling out a shell that greets whatever it is handed. A
   * surface that sends an unasked-for message to an agent would be worse than
   * one that sends none.
   */
  it('with no kickoffAgentId, sendMessage is never called', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Today' });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
