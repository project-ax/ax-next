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

  it('still works outside a WorkspaceProvider', async () => {
    railMock.mockResolvedValue(rail());
    const { result } = renderHook(() => useAgentRail('a1'));
    await waitFor(() => expect(result.current.rail).not.toBeNull());
  });
});
