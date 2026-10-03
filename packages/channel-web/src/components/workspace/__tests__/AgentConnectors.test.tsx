/**
 * The agent's connector list (TASK-739, connectors-rail slice 6).
 *
 * Pinned: rows are the connector NAME only; the ⋯ menu holds exactly what is
 * wired (Edit connector for an editable one, then Remove from <agent>);
 * removing asks first and never drops a row the server still has; the empty
 * state; and no Add / View details / Reconnect before their slices land.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError, type AgentDetail } from '@/lib/workspace-api';
import { getConnector } from '@/lib/connectors';
import type { AgentConnectorRow } from '@/lib/workspace-types';
import { AgentRail } from '../AgentRail';
import { rail } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      rail: vi.fn(),
      revokeGrant: vi.fn(),
      abilities: vi.fn(),
      setAbility: vi.fn(),
      connectors: vi.fn(),
      removeConnector: vi.fn(),
    },
  };
});

vi.mock('@/lib/connectors', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/connectors');
  return { ...actual, getConnector: vi.fn() };
});

const connectorsMock = vi.mocked(workspaceApi.connectors);
const removeMock = vi.mocked(workspaceApi.removeConnector);
const railMock = vi.mocked(workspaceApi.rail);

const ROWS: AgentConnectorRow[] = [
  { id: 'linear', name: 'Linear', source: 'attached', editable: true },
  { id: 'gmail', name: 'Gmail', source: 'default', editable: false },
];

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

beforeEach(() => {
  vi.clearAllMocks();
  railMock.mockResolvedValue(rail());
  vi.mocked(workspaceApi.abilities).mockResolvedValue({
    abilities: { webSearch: true, readPages: true, runCode: true },
  });
  connectorsMock.mockResolvedValue({ connectors: ROWS });
});

describe('connector list', () => {
  it('shows "Connectors <n>" and one row per connector, by name only', async () => {
    renderTab();
    expect(await screen.findByText('Linear')).toBeTruthy();
    expect(screen.getByText('Gmail')).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 3, name: /^Connectors/ });
    expect(heading.textContent).toBe('Connectors2');
    // Name only: no tool counts, no two-letter tiles.
    expect(screen.queryByText(/tools ·|ask first/i)).toBeNull();
    expect(connectorsMock).toHaveBeenCalledWith('a-quill');
  });

  it('draws no Add button before TASK-740 wires it', async () => {
    renderTab();
    await screen.findByText('Linear');
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
  });

  it('says it could not read the list rather than showing an empty one', async () => {
    connectorsMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/connectors', 500));
    renderTab();
    expect(await screen.findByText(/couldn’t read Quill’s connectors/)).toBeTruthy();
    expect(screen.queryByText(/No connectors yet/)).toBeNull();
  });
});

describe('row menu', () => {
  it('offers Edit connector and Remove from <agent> for an editable connector', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Edit connector', 'Remove from Quill']);
    // Not wired yet — their slices add them.
    expect(within(menu).queryByText(/View details|Reconnect|Retry/)).toBeNull();
  });

  it('hides Edit connector for one this person cannot edit', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Remove from Quill']);
  });

  it('opens the Settings connector editor for Edit connector', async () => {
    vi.mocked(getConnector).mockRejectedValue(new Error('offline'));
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit connector' }));
    await waitFor(() =>
      expect(getConnector).toHaveBeenCalledWith('linear', '/settings/connectors'),
    );
    expect(await screen.findByText(/couldn’t open Linear just now/)).toBeTruthy();
  });
});

describe('remove', () => {
  it('asks first, and Keep it changes nothing', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove Linear from Quill?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('removes on confirm, then draws what the server re-read and refreshes the rail', async () => {
    removeMock.mockResolvedValue({ removed: true, cleanup: 'complete' });
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    const dialog = await screen.findByRole('dialog');
    const railReads = railMock.mock.calls.length;
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Linear')).toBeNull());
    expect(removeMock).toHaveBeenCalledWith('a-quill', 'linear');
    expect(screen.getByText('Gmail')).toBeTruthy();
    // The rail's grants are re-read: the connector's approved access went too.
    await waitFor(() => expect(railMock.mock.calls.length).toBeGreaterThan(railReads));
  });

  it('keeps the row and says nothing changed when the remove fails', async () => {
    removeMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/connectors/linear', 500));
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/couldn’t remove Linear just now\. Nothing changed\./)).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
  });

  it('says so when the connector went but some cleanup did not', async () => {
    removeMock.mockResolvedValue({ removed: true, cleanup: 'partial' });
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!] });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/Removed Linear\. Some of what you’d approved/)).toBeTruthy();
  });
});

describe('empty state', () => {
  it('is a dashed card with the plug, the title and the copy — and no Add yet', async () => {
    connectorsMock.mockResolvedValue({ connectors: [] });
    const { container } = renderTab();
    expect(await screen.findByText('No connectors yet')).toBeTruthy();
    expect(
      screen.getByText('Connect a tool like Linear or Gmail and Quill can work in it for you.'),
    ).toBeTruthy();
    const empty = container.querySelector('[data-slot="empty"]');
    expect(empty?.className).toContain('border-dashed');
    expect(empty?.querySelector('svg.lucide-plug')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Add connector/ })).toBeNull();
    // No count when there is nothing to count.
    expect(screen.getByRole('heading', { level: 3, name: /^Connectors/ }).textContent).toBe(
      'Connectors',
    );
  });
});
