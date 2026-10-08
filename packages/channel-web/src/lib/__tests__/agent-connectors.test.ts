/**
 * The Connectors tab's list as state: who may do what (TASK-798 / TASK-813 /
 * slice 3), and what a Remove answered. Slice 3 — no Retry (its route is
 * gone), and Remove never signs anyone out of anything.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentConnectorRow } from '@/lib/workspace-types';
import { useAgentConnectors, type RemoveOutcome } from '../agent-connectors';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      connectors: vi.fn(),
      removeConnector: vi.fn(),
    },
  };
});

const connectorsMock = vi.mocked(workspaceApi.connectors);
const removeMock = vi.mocked(workspaceApi.removeConnector);

function row(over: Partial<AgentConnectorRow> = {}): AgentConnectorRow {
  return {
    id: 'slack',
    name: 'Slack',
    source: 'attached',
    editable: true,
    health: 'unreachable',
    removable: true,
    ...over,
  };
}

async function loaded(rows: AgentConnectorRow[]) {
  connectorsMock.mockResolvedValue({ connectors: rows, shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
  const hook = renderHook(() => useAgentConnectors('a-quill'));
  await waitFor(() => expect(hook.result.current.status).toBe('ok'));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('remove() (slice 3)', () => {
  it.each([
    ['complete', 'removed'],
    ['partial', 'removed-partial'],
  ] as const)('cleanup %s answers %s', async (cleanup, outcome) => {
    const hook = await loaded([row()]);
    removeMock.mockResolvedValueOnce({ removed: true, cleanup });
    let out: RemoveOutcome | undefined;
    await act(async () => {
      out = await hook.result.current.remove('slack');
    });
    expect(out).toBe(outcome);
  });

  it('a failed remove answers failed', async () => {
    const hook = await loaded([row()]);
    removeMock.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let out: RemoveOutcome | undefined;
    await act(async () => {
      out = await hook.result.current.remove('slack');
    });
    expect(out).toBe('failed');
  });
});

describe('canSetAccount (slice 3)', () => {
  async function read(over: { shared: boolean; sharedCredentials?: boolean }) {
    connectorsMock.mockResolvedValueOnce({
      connectors: [row()],
      connectorsSupported: true,
      manageable: true,
      ...over,
    } as never);
    const hook = renderHook(() => useAgentConnectors('a-quill'));
    expect(hook.result.current.canSetAccount).toBe(false);
    await waitFor(() => expect(hook.result.current.status).toBe('ok'));
    return hook.result.current.canSetAccount;
  }

  it('is true on a personal agent (its owner), once the list is read', async () => {
    expect(await read({ shared: false, sharedCredentials: false })).toBe(true);
  });

  it('on a team agent, follows sharedCredentials: a team admin yes, anyone else no', async () => {
    expect(await read({ shared: true, sharedCredentials: true })).toBe(true);
    expect(await read({ shared: true, sharedCredentials: false })).toBe(false);
    // A server that never sent the flag: nothing is offered.
    expect(await read({ shared: true })).toBe(false);
  });

  it('is false while the list could not be read', async () => {
    connectorsMock.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = renderHook(() => useAgentConnectors('a-quill'));
    await waitFor(() => expect(hook.result.current.status).toBe('failed'));
    expect(hook.result.current.canSetAccount).toBe(false);
  });
});

describe('manageable (TASK-798)', () => {
  it('is false until the list is read, then says what the server answered', async () => {
    connectorsMock.mockResolvedValue({ connectors: [row()], shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    const hook = renderHook(() => useAgentConnectors('a-quill'));
    expect(hook.result.current.manageable).toBe(false);
    await waitFor(() => expect(hook.result.current.status).toBe('ok'));
    expect(hook.result.current.manageable).toBe(true);
  });

  it('stays false for a member, and when the server sent no answer', async () => {
    connectorsMock.mockResolvedValueOnce({ connectors: [row()], shared: true, connectorsSupported: true, manageable: false, sharedCredentials: false });
    const member = renderHook(() => useAgentConnectors('a-quill'));
    await waitFor(() => expect(member.result.current.status).toBe('ok'));
    expect(member.result.current.manageable).toBe(false);

    // A server that never sent the flag: nothing is offered.
    connectorsMock.mockResolvedValueOnce({ connectors: [row()], shared: true, connectorsSupported: true } as never);
    const old = renderHook(() => useAgentConnectors('a-quill'));
    await waitFor(() => expect(old.result.current.status).toBe('ok'));
    expect(old.result.current.manageable).toBe(false);
  });
});

describe('sharedCredentials (TASK-813)', () => {
  it('is false until read, then follows the server — independent of manageable', async () => {
    // A workspace admin who is not the team's admin: may manage, may not sign in on it.
    connectorsMock.mockResolvedValueOnce({ connectors: [row()], shared: true, connectorsSupported: true, manageable: true, sharedCredentials: false });
    const admin = renderHook(() => useAgentConnectors('a-quill'));
    expect(admin.result.current.sharedCredentials).toBe(false);
    await waitFor(() => expect(admin.result.current.status).toBe('ok'));
    expect(admin.result.current.manageable).toBe(true);
    expect(admin.result.current.sharedCredentials).toBe(false);

    connectorsMock.mockResolvedValueOnce({ connectors: [row()], shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    const teamAdmin = renderHook(() => useAgentConnectors('a-quill'));
    await waitFor(() => expect(teamAdmin.result.current.status).toBe('ok'));
    expect(teamAdmin.result.current.sharedCredentials).toBe(true);

    // A server that never sent the flag: nothing is offered.
    connectorsMock.mockResolvedValueOnce({ connectors: [row()], shared: true, connectorsSupported: true, manageable: true } as never);
    const old = renderHook(() => useAgentConnectors('a-quill'));
    await waitFor(() => expect(old.result.current.status).toBe('ok'));
    expect(old.result.current.sharedCredentials).toBe(false);
  });
});

describe('refresh() (slice 4)', () => {
  it('resolves with the rows the re-read returned', async () => {
    const hook = await loaded([row({ signedIn: { account: 'a@x', byName: null, byYou: true, at: null } })]);
    const fresh = [row({ signedIn: { account: 'b@x', byName: null, byYou: true, at: null } })];
    connectorsMock.mockResolvedValueOnce({ connectors: fresh, shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    let out: AgentConnectorRow[] | null | undefined;
    await act(async () => {
      out = await hook.result.current.refresh();
    });
    expect(out).toEqual(fresh);
    expect(hook.result.current.connectors).toEqual(fresh);
  });

  it('resolves null when the re-read fails, or a newer read superseded it', async () => {
    const hook = await loaded([row()]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectorsMock.mockRejectedValueOnce(new Error('boom'));
    let failed: AgentConnectorRow[] | null | undefined;
    await act(async () => {
      failed = await hook.result.current.refresh();
    });
    expect(failed).toBeNull();

    connectorsMock.mockResolvedValue({ connectors: [row()], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    let first: Promise<AgentConnectorRow[] | null> | undefined;
    await act(async () => {
      first = hook.result.current.refresh();
      await hook.result.current.refresh();
    });
    expect(await first).toBeNull();
  });
});
