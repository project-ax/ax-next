/**
 * Today's "N done today" must never be the count for ONE agent.
 *
 * `useActivityFeed` is a single hook instance serving two collections — the
 * whole workspace on Today, one agent on an agent tab — and the scope change
 * lands in an EFFECT. Effects run after the commit, so on the first render
 * back on Today `events` and `nextBefore` still describe the agent just left,
 * and `doneTodayFrom` counted them. One frame of the workspace being told that
 * one agent's day was the whole account's.
 *
 * Why this file records props instead of reading the DOM: the bug is exactly
 * one render wide, and Testing Library's `act` flushes passive effects before
 * handing control back — so by the time any `screen.*` query runs, the reset
 * has already happened and the stale frame is gone. A `queryByText` assertion
 * here would pass against the unfixed code, which is the failure mode
 * CLAUDE.md's Bug Fix Policy is meant to prevent. Recording what `TodayView`
 * was HANDED, on every render, is what makes the frame observable at all.
 *
 * TASK-402. The fix this pins was written once before, as TASK-250's T2, and
 * was reverted with the tier that would have consumed it (#565). Its PR body
 * called this counter out by name as the consumer that still existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { workspaceGrantActions } from '@/lib/workspace-grant-store';
import type { ActivityEvent } from '@/lib/workspace-types';
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
      grants: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

/**
 * Every value `TodayView` was handed for `doneToday`, one entry per render.
 * The real component is replaced rather than wrapped on purpose: this file is
 * about the number the shell COMPUTES, and `TodayView`'s own rendering of it
 * (the positive-only test that drops a zero) is pinned in `TodayView.test.tsx`.
 */
const handed: (number | undefined)[] = [];

vi.mock('../TodayView', () => ({
  TodayView: ({ doneToday }: { doneToday?: number }) => {
    handed.push(doneToday);
    return <div data-testid="today-pane" />;
  },
}));

const boardMock = vi.mocked(workspaceApi.board);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const grantsMock = vi.mocked(workspaceApi.grants);
const agentMock = vi.mocked(workspaceApi.agent);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

/*
  A pinned clock, for the same reason `WorkspaceShell.test.tsx`'s count suite
  pins one: the fixture rows and the "today" the component derives while it
  renders are read at different moments, and a run straddling local midnight
  would have them disagree about which day it is.
*/
const NOW = new Date(2026, 7, 23, 14, 30, 0);
const midnight = new Date(2026, 7, 23).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

/** A `done` row from this morning — the only kind the count looks at. */
function doneEvent(agentId: string, n: number): ActivityEvent {
  return {
    id: `${agentId}-e-${n}`,
    agentId,
    at: iso(midnight + 9 * 60 * 60 * 1000),
    text: `Swept the inbox (${n})`,
    kind: 'done',
    detail: null,
    tag: null,
    decisionId: null,
  };
}

/**
 * Two counts that cannot be mistaken for one another. The agent's is the
 * number that must never reach Today; the workspace's is what Today is
 * entitled to show.
 */
const AGENT_DONE = 3;
const WORKSPACE_DONE = 7;

const quill = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, '', '/workspace');
  handed.length = 0;

  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [quill] });
  agentMock.mockReset();
  agentMock.mockResolvedValue({
    agent: quill,
    conversationId: null,
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
      learned: { status: 'unavailable', docs: [] },
    },
  });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  grantsMock.mockReset();
  grantsMock.mockResolvedValue({ grants: [] });
  workspaceGrantActions.resetForTest();

  /*
    The cursor reaches back past midnight on BOTH scopes, so `doneTodayFrom`'s
    honesty gate passes either way and the only thing deciding the number is
    which collection is in hand. That is the point: if the gate were doing the
    work here, this test would pass for the wrong reason.
  */
  activityMock.mockReset();
  activityMock.mockImplementation(async (params?: { agentId?: string }) => {
    const scoped = params?.agentId !== undefined;
    return {
      events: Array.from({ length: scoped ? AGENT_DONE : WORKSPACE_DONE }, (_, i) =>
        doneEvent(scoped ? params.agentId! : 'a-quill', i),
      ),
      nextBefore: iso(midnight - 1_000),
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Today’s "done today" count across an agent switch', () => {
  it('never renders the agent’s count as the workspace’s, not even for one frame', async () => {
    render(
      <UserProvider value={user}>
        <WorkspaceShell />
      </UserProvider>,
    );

    // Today, with the whole workspace behind it.
    await waitFor(() => expect(activityMock).toHaveBeenCalledWith({}));
    await waitFor(() => expect(handed).toContain(WORKSPACE_DONE));

    // Into the agent's tab. The feed re-scopes to Quill alone.
    fireEvent.click(await screen.findByRole('button', { name: /Quill/ }));
    await waitFor(() =>
      expect(activityMock).toHaveBeenCalledWith({ agentId: 'a-quill' }),
    );

    /*
      From here on, every recorded value is one Today actually rendered —
      `TodayView` is mounted only on the Today route. Clearing now is what
      makes the assertion below about the RETURN trip and nothing else.
    */
    handed.length = 0;

    fireEvent.click(await screen.findByRole('button', { name: 'Today' }));
    await waitFor(() => expect(handed).toContain(WORKSPACE_DONE));

    // The whole card: Quill's 3 must not appear on Today at any point.
    expect(handed).not.toContain(AGENT_DONE);
  });
});
