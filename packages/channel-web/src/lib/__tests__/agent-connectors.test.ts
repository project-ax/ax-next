/**
 * TASK-795 — Retry's answer patches the row it checked: health, whose
 * sign-in (TASK-756), and now which first-time setup a `needs-sign-in` row
 * offers. A setup the answer leaves out must not linger on the row.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentConnectorRow } from '@/lib/workspace-types';
import { useAgentConnectors, type RetryResult } from '../agent-connectors';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      connectors: vi.fn(),
      removeConnector: vi.fn(),
      retryConnector: vi.fn(),
    },
  };
});

const connectorsMock = vi.mocked(workspaceApi.connectors);
const retryMock = vi.mocked(workspaceApi.retryConnector);

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
  connectorsMock.mockResolvedValue({ connectors: rows, shared: false, connectorsSupported: true, manageable: true });
  const hook = renderHook(() => useAgentConnectors('a-quill'));
  await waitFor(() => expect(hook.result.current.status).toBe('ok'));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retry() and the row setup (TASK-795)', () => {
  it('carries the setup a needs-sign-in answer names onto the row, and returns it', async () => {
    const hook = await loaded([row()]);
    retryMock.mockResolvedValueOnce({ health: 'needs-sign-in', setup: 'add-key' });
    let out: RetryResult | undefined;
    await act(async () => {
      out = await hook.result.current.retry('slack');
    });
    expect(out).toEqual({ outcome: 'needs-sign-in', sharedSignIn: false, setup: 'add-key' });
    expect(hook.result.current.connectors?.[0]).toMatchObject({
      health: 'needs-sign-in',
      setup: 'add-key',
    });
  });

  it('drops a stale setup when the answer has none', async () => {
    const hook = await loaded([row({ setup: 'sign-in' })]);
    retryMock.mockResolvedValueOnce({ health: 'unreachable' });
    let out: RetryResult | undefined;
    await act(async () => {
      out = await hook.result.current.retry('slack');
    });
    expect(out).toEqual({ outcome: 'unreachable', sharedSignIn: false });
    const after = hook.result.current.connectors?.[0];
    expect(after?.health).toBe('unreachable');
    expect(after !== undefined && 'setup' in after).toBe(false);
  });
});

describe('manageable (TASK-798)', () => {
  it('is false until the list is read, then says what the server answered', async () => {
    connectorsMock.mockResolvedValue({ connectors: [row()], shared: true, connectorsSupported: true, manageable: true });
    const hook = renderHook(() => useAgentConnectors('a-quill'));
    expect(hook.result.current.manageable).toBe(false);
    await waitFor(() => expect(hook.result.current.status).toBe('ok'));
    expect(hook.result.current.manageable).toBe(true);
  });

  it('stays false for a member, and when the server sent no answer', async () => {
    connectorsMock.mockResolvedValueOnce({ connectors: [row()], shared: true, connectorsSupported: true, manageable: false });
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
