/**
 * `useAgentRail` follows the roster's working/resting word (TASK-686).
 *
 * The rail's "Right now" line is fetched on its own, and it used to be fetched
 * ONCE per agent: when a reply finished, the header pill, the sidebar row and
 * the Today strip all re-read and flipped to resting, while the rail kept the
 * "Working on your request" line it read when the turn started — four
 * surfaces, one of them disagreeing. The re-read that fixes the others is the
 * roster refresh a finished turn triggers, so the rail re-reads when the
 * roster's word for its agent changes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import { WorkspaceProvider, useWorkspace } from '../workspace-context';
import { useAgentRail } from '../workspace-rail';
import { rail, railActivity } from '@/components/workspace/__tests__/rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: { rail: vi.fn(), revokeGrant: vi.fn(), board: vi.fn() },
  };
});

const railMock = vi.mocked(workspaceApi.rail);
const boardMock = vi.mocked(workspaceApi.board);

function agent(state: WorkspaceAgent['state']): WorkspaceAgent {
  return {
    id: 'a1',
    name: 'Juniper',
    state,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAgentRail', () => {
  it("re-reads the rail when the roster's word for its agent changes", async () => {
    boardMock.mockResolvedValueOnce({ agents: [agent('working')] });
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({ phrase: 'Working on your request', source: 'trigger' }),
        },
      }),
    );

    const { result } = renderHook(
      () => ({ rail: useAgentRail('a1'), ws: useWorkspace() }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.rail.rail?.activity.activity?.phrase).toBe(
        'Working on your request',
      ),
    );
    await waitFor(() => expect(result.current.ws.board?.agents[0]?.state).toBe('working'));

    // The reply finished: the server now reads resting, and the finished turn
    // refreshes the roster (AgentView's onDone → onChanged → refresh).
    railMock.mockResolvedValue(rail());
    boardMock.mockResolvedValueOnce({ agents: [agent('resting')] });
    await act(async () => {
      await result.current.ws.refresh();
    });

    await waitFor(() => expect(result.current.rail.rail?.activity.activity).toBeNull());
  });

  /*
    TASK-707 — the brand-new-agent flow. The roster read that follows create
    lands BEFORE the server marks the agent working, so the roster word goes
    resting -> resting and never transitions. The word the SPA did see change
    is the agent detail's (AgentView re-reads it on the done frame), so that
    word drives a re-read too.
  */
  it("re-reads the rail when the agent detail's word changes but the roster's never does", async () => {
    boardMock.mockResolvedValue({ agents: [agent('resting')] });
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({ phrase: 'Working on your request', source: 'trigger' }),
        },
      }),
    );

    const { result, rerender } = renderHook(
      ({ word }: { word: WorkspaceAgent['state'] }) => ({
        rail: useAgentRail('a1', word),
        ws: useWorkspace(),
      }),
      { wrapper, initialProps: { word: 'working' as WorkspaceAgent['state'] } },
    );
    await waitFor(() => expect(result.current.ws.board?.agents[0]?.state).toBe('resting'));
    await waitFor(() =>
      expect(result.current.rail.rail?.activity.activity?.phrase).toBe(
        'Working on your request',
      ),
    );

    // The reply finished: the detail re-read says resting, and the roster's
    // refresh says resting again — no roster transition at all.
    railMock.mockResolvedValue(rail());
    await act(async () => {
      await result.current.ws.refresh();
    });
    rerender({ word: 'resting' });

    await waitFor(() => expect(result.current.rail.rail?.activity.activity).toBeNull());
  });

  /*
    TASK-818 — the phone sheet mounts mid-turn (Details opened on Activity
    right after the first send). Its mount read says "Working on your
    request", but neither word ever moves: the detail was read before the
    server marked the agent working and is re-read after it stopped, and the
    roster goes resting -> resting. The turn finishing (busy true -> false) is
    the one transition this panel can still see, so it re-reads on that.
  */
  it('re-reads the rail when the turn finishes even though neither word changed', async () => {
    boardMock.mockResolvedValue({ agents: [agent('resting')] });
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({ phrase: 'Working on your request', source: 'trigger' }),
        },
      }),
    );

    const { result, rerender } = renderHook(
      ({ busy }: { busy: boolean }) => ({
        rail: useAgentRail('a1', 'resting', busy),
        ws: useWorkspace(),
      }),
      { wrapper, initialProps: { busy: true } },
    );
    await waitFor(() => expect(result.current.ws.board?.agents[0]?.state).toBe('resting'));
    await waitFor(() =>
      expect(result.current.rail.rail?.activity.activity?.phrase).toBe(
        'Working on your request',
      ),
    );

    // The reply landed and its re-read settled: still resting everywhere.
    railMock.mockResolvedValue(rail());
    await act(async () => {
      await result.current.ws.refresh();
    });
    rerender({ busy: false });

    await waitFor(() => expect(result.current.rail.rail?.activity.activity).toBeNull());
  });

  // The second message: the panel is already open, so the turn STARTING is
  // the moment it can learn the agent is working again.
  it('re-reads the rail when a turn starts', async () => {
    railMock.mockResolvedValue(rail());
    const { result, rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useAgentRail('a1', 'resting', busy),
      { initialProps: { busy: false } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(railMock).toHaveBeenCalledTimes(1);

    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({ phrase: 'Working on your request', source: 'trigger' }),
        },
      }),
    );
    rerender({ busy: true });
    await waitFor(() =>
      expect(result.current.rail?.activity.activity?.phrase).toBe('Working on your request'),
    );
    expect(railMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-read when a roster refresh leaves its agent word unchanged', async () => {
    boardMock.mockResolvedValue({ agents: [agent('resting')] });
    railMock.mockResolvedValue(rail());

    const { result } = renderHook(
      () => ({ rail: useAgentRail('a1'), ws: useWorkspace() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.ws.board?.agents[0]?.state).toBe('resting'));
    await waitFor(() => expect(result.current.rail.loading).toBe(false));
    const reads = railMock.mock.calls.length;

    await act(async () => {
      await result.current.ws.refresh();
    });
    expect(railMock.mock.calls.length).toBe(reads);
  });

  it('reads a newly selected agent once, not once per effect', async () => {
    boardMock.mockResolvedValue({
      agents: [agent('resting'), { ...agent('working'), id: 'a2' }],
    });
    railMock.mockResolvedValue(rail());

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => ({ rail: useAgentRail(id), ws: useWorkspace() }),
      { wrapper, initialProps: { id: 'a1' } },
    );
    await waitFor(() => expect(result.current.ws.board?.agents.length).toBe(2));
    await waitFor(() => expect(result.current.rail.loading).toBe(false));
    const reads = railMock.mock.calls.length;

    rerender({ id: 'a2' });
    await waitFor(() => expect(result.current.rail.loading).toBe(false));
    expect(railMock.mock.calls.slice(reads)).toEqual([['a2']]);
  });

  // The word-change effect also runs on mount; only the mount read is the
  // first effect's, so the second must not add one of its own.
  it('reads once on mount, not once per effect', async () => {
    railMock.mockResolvedValue(rail());
    const { result } = renderHook(() => useAgentRail('a1', 'resting'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(railMock).toHaveBeenCalledTimes(1);
  });

  it('still works outside a WorkspaceProvider', async () => {
    railMock.mockResolvedValue(rail());
    const { result } = renderHook(() => useAgentRail('a1'));
    await waitFor(() => expect(result.current.rail).not.toBeNull());
  });
});
