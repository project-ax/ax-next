/**
 * TASK-858 — a team admin removes the team sign-in saved on a team agent.
 *
 * Pinned:
 *   - "Remove team sign-in" is on a row's `⋯` menu only when the row says
 *     `teamSignIn` (the server sends it only to the team's admins, and only
 *     when such a sign-in is saved);
 *   - it asks first; "Keep it" calls nothing;
 *   - "Remove" calls `removeTeamSignIn(agentId, connectorId)`, closes, says so,
 *     and re-reads the list;
 *   - a refusal shows the api's sentence as an error and keeps the row.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, TEAM_SIGN_IN_FORBIDDEN, type AgentDetail } from '@/lib/workspace-api';
import { HttpError } from '@/lib/http';
import type { AgentConnectorRow, AgentConnectorsRead } from '@/lib/workspace-types';
import { AgentRail } from '../AgentRail';
import { rail } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace-api')>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      rail: vi.fn(),
      revokeGrant: vi.fn(),
      abilities: vi.fn(),
      setAbility: vi.fn(),
      connectors: vi.fn(),
      removeConnector: vi.fn(),
      retryConnector: vi.fn(),
      connectorTools: vi.fn(),
      setToolVerdict: vi.fn(),
      removeTeamSignIn: vi.fn(),
    },
  };
});

const connectorsMock = vi.mocked(workspaceApi.connectors);
const removeMock = vi.mocked(workspaceApi.removeTeamSignIn);

function row(over: Partial<AgentConnectorRow>): AgentConnectorRow {
  return {
    id: 'linear',
    name: 'Linear',
    source: 'attached',
    editable: false,
    health: 'ok',
    removable: true,
    ...over,
  };
}

function detail(): AgentDetail {
  return {
    agent: {
      id: 'a-quill',
      name: 'Quill',
      state: 'resting',
      now: null,
      counter: null,
      startedAt: null,
      stoppedReason: null,
    },
    conversationId: null,
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
  };
}

function list(connectors: AgentConnectorRow[], over: Partial<AgentConnectorsRead> = {}) {
  connectorsMock.mockResolvedValue({
    connectors,
    shared: true,
    connectorsSupported: true,
    manageable: true,
    sharedCredentials: true,
    ...over,
  });
}

function renderTab() {
  return render(
    <AgentRail detail={detail()} openPastId={null} onOpenPast={vi.fn()} tab="connectors" />,
  );
}

async function openMenu(name: string) {
  const trigger = await screen.findByRole('button', { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

async function menuItems(name: string) {
  const menu = await openMenu(name);
  return within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent);
}

async function openConfirm(name: string) {
  const menu = await openMenu(name);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove team sign-in' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceApi.rail).mockResolvedValue(rail());
  vi.mocked(workspaceApi.abilities).mockResolvedValue({
    abilities: { webSearch: true, readPages: true, runCode: true },
  });
});

describe('Remove team sign-in (TASK-858)', () => {
  it('is on the menu only for a row that says teamSignIn', async () => {
    list([row({ teamSignIn: true }), row({ id: 'gmail', name: 'Gmail' })]);
    renderTab();
    expect(await menuItems('Linear')).toEqual([
      'View details',
      'Remove team sign-in',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await menuItems('Gmail')).not.toContain('Remove team sign-in');
  });

  it('asks first, then removes it, says so, and re-reads the list', async () => {
    list([row({ teamSignIn: true })]);
    removeMock.mockResolvedValue(undefined);
    renderTab();
    const dialog = await openConfirm('Linear');
    expect(
      within(dialog).getByRole('heading', { name: 'Remove the team sign-in to Linear?' }),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Everyone using Quill loses access to Linear/)).toBeTruthy();
    expect(removeMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith('a-quill', 'linear');
    expect(await screen.findByText('Removed the team sign-in to Linear.')).toBeTruthy();
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledTimes(2));
  });

  it('shows Removing… while it runs', async () => {
    list([row({ teamSignIn: true })]);
    let finish: () => void = () => {};
    removeMock.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    renderTab();
    const dialog = await openConfirm('Linear');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const busy = await within(dialog).findByRole('button', { name: 'Removing…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Keep it closes without removing anything', async () => {
    list([row({ teamSignIn: true })]);
    renderTab();
    const dialog = await openConfirm('Linear');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(removeMock).not.toHaveBeenCalled();
    expect(connectorsMock).toHaveBeenCalledTimes(1);
  });

  it('a refusal shows the api’s sentence as an error, and the row stays', async () => {
    list([row({ teamSignIn: true })]);
    removeMock.mockRejectedValue(new HttpError('/x', 403, TEAM_SIGN_IN_FORBIDDEN));
    renderTab();
    const dialog = await openConfirm('Linear');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(TEAM_SIGN_IN_FORBIDDEN);
    expect(screen.queryByText('Removed the team sign-in to Linear.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Linear' })).toBeTruthy();
  });

  it('an unexpected failure still says nothing changed', async () => {
    list([row({ teamSignIn: true })]);
    removeMock.mockRejectedValue(new Error('boom'));
    renderTab();
    const dialog = await openConfirm('Linear');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We couldn’t remove the team sign-in to Linear just now. Nothing changed.');
    expect(alert.textContent).not.toContain('boom');
  });
});
