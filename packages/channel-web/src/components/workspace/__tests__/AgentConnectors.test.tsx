/**
 * The agent's connector list (TASK-739, connectors-rail slice 6).
 *
 * Pinned: rows are the connector NAME only; the ⋯ menu holds exactly what is
 * wired (Edit connector for an editable one, then Remove from <agent>);
 * removing asks first and never drops a row the server still has; the empty
 * state; "+ Add" / "Add connector" open the Add subview (TASK-740). View
 * details arrived with TASK-742 (see ConnectorDetails.test.tsx).
 *
 * TASK-741 (slice 8): an errored row wears ONE red icon after its name — no
 * inline error text — whose reason is its accessible name and a tooltip that
 * opens on keyboard focus too; the menu leads with Reconnect or Retry, on
 * errored rows only; Retry runs one check and the row takes its answer.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      retryConnector: vi.fn(),
    },
  };
});

vi.mock('@/lib/connectors-oauth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/connectors-oauth');
  return {
    ...actual,
    getOAuthStatus: vi.fn(async () => 'needs-reconnect'),
    beginOAuth: vi.fn(),
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
  { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
  { id: 'gmail', name: 'Gmail', source: 'default', editable: false, health: 'ok', removable: true },
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
  connectorsMock.mockResolvedValue({ connectors: ROWS, shared: false, connectorsSupported: true });
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

  it('draws "+ Add" beside the heading, and it opens the Add subview (TASK-740)', async () => {
    renderTab();
    await screen.findByText('Linear');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('heading', { name: 'Add a connector' })).toBeTruthy();
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
    expect(items).toEqual(['View details', 'Edit connector', 'Remove from Quill']);
    // Not wired yet — its slice adds it. A healthy row offers no fix.
    expect(within(menu).queryByText(/Reconnect|Retry/)).toBeNull();
  });

  it('hides Edit connector for one this person cannot edit', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['View details', 'Remove from Quill']);
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
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true });
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
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/Removed Linear\. Some of what you’d approved/)).toBeTruthy();
  });
});

// TASK-765 — removing a workspace default from a team agent takes it away
// from every member, so only the agent's owner or an admin may. The server
// says which rows this caller may remove; the item for any other row stays in
// the menu (so the reason can be found) but is disabled and says why.
describe('a connector this person may not remove (TASK-765)', () => {
  const REASON = "Only the agent’s owner or an admin can remove this.";
  const MIXED: AgentConnectorRow[] = [
    { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
    { id: 'gmail', name: 'Gmail', source: 'default', editable: false, health: 'ok', removable: false },
  ];

  beforeEach(() => {
    connectorsMock.mockResolvedValue({ connectors: MIXED, shared: true, connectorsSupported: true });
  });

  it('keeps the item, same name, announced as disabled with the reason as its description', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const item = within(menu).getByRole('menuitem', { name: 'Remove from Quill' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('aria-description')).toBe(REASON);
    // Muted, not destructive red: it is not an action this person has.
    expect(item.className).toContain('text-muted-foreground');
    expect(item.className).not.toContain('text-destructive');
  });

  it('selecting it does nothing: no confirmation, no DELETE', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const item = within(menu).getByRole('menuitem', { name: 'Remove from Quill' });
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('says why in a tooltip on keyboard focus', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const item = within(menu).getByRole('menuitem', { name: 'Remove from Quill' });
    act(() => item.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(REASON);
  });

  it('says why in a tooltip on hover', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const item = within(menu).getByRole('menuitem', { name: 'Remove from Quill' });
    fireEvent.pointerMove(item, { pointerType: 'mouse' });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(REASON);
  });

  it('a removable row in the same list is unchanged: enabled, and it asks first', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    const item = within(menu).getByRole('menuitem', { name: 'Remove from Quill' });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    expect(item.getAttribute('aria-description')).toBeNull();
    fireEvent.click(item);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('empty state', () => {
  it('is a dashed card with the plug, the title, the copy and "Add connector"', async () => {
    connectorsMock.mockResolvedValue({ connectors: [], shared: false, connectorsSupported: true });
    const { container } = renderTab();
    expect(await screen.findByText('No connectors yet')).toBeTruthy();
    expect(
      screen.getByText('Connect a tool like Linear or Gmail and Quill can work in it for you.'),
    ).toBeTruthy();
    const empty = container.querySelector('[data-slot="empty"]');
    expect(empty?.className).toContain('border-dashed');
    expect(empty?.querySelector('svg.lucide-plug')).not.toBeNull();
    // The empty state's own button, not a second "+ Add" in the header.
    expect(screen.getByRole('button', { name: 'Add connector' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    // No count when there is nothing to count.
    expect(screen.getByRole('heading', { level: 3, name: /^Connectors/ }).textContent).toBe(
      'Connectors',
    );
  });
});

describe('connector health (TASK-741)', () => {
  const ERRORED: AgentConnectorRow[] = [
    { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
    { id: 'gmail', name: 'Gmail', source: 'default', editable: false, health: 'needs-reconnect', removable: true },
    { id: 'slack', name: 'Slack', source: 'attached', editable: true, health: 'unreachable', removable: true },
  ];
  const retryMock = vi.mocked(workspaceApi.retryConnector);

  beforeEach(() => {
    connectorsMock.mockResolvedValue({ connectors: ERRORED, shared: false, connectorsSupported: true });
  });

  it('puts ONE icon after an errored name, named by its reason, with no inline error text', async () => {
    renderTab();
    const expired = await screen.findByRole('button', { name: 'Your sign-in expired' });
    const unreachable = screen.getByRole('button', { name: 'Can’t reach it' });
    // Right after the name, inside the same row.
    expect(expired.previousElementSibling?.textContent).toBe('Gmail');
    expect(unreachable.previousElementSibling?.textContent).toBe('Slack');
    expect(expired.querySelector('svg.lucide-circle-alert')).not.toBeNull();
    expect(expired.className).toContain('text-destructive');
    // The healthy row has no icon, and nothing spells the reason out inline.
    expect(screen.getAllByRole('button', { name: /Your sign-in expired|Can’t reach it/ })).toHaveLength(2);
    expect(screen.queryByText('Your sign-in expired')).toBeNull();
    expect(screen.queryByText('Can’t reach it')).toBeNull();
  });

  it('shows the reason in a tooltip when the icon gets keyboard focus', async () => {
    renderTab();
    const icon = await screen.findByRole('button', { name: 'Your sign-in expired' });
    icon.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Your sign-in expired');
  });

  // TASK-756 — a team agent's shared sign-in is the team's, not this person's.
  it('names a shared expired sign-in as the team’s, in the icon and the Reconnect dialog', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [
        { id: 'gmail', name: 'Gmail', source: 'default', editable: false, health: 'needs-reconnect', sharedSignIn: true, removable: true },
      ],
      shared: true,
      connectorsSupported: true,
    });
    renderTab();
    const icon = await screen.findByRole('button', { name: 'Team sign-in expired' });
    icon.focus();
    expect((await screen.findByRole('tooltip')).textContent).toBe('Team sign-in expired');
    expect(screen.queryByRole('button', { name: 'Your sign-in expired' })).toBeNull();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/The team sign-in to Gmail expired/)).toBeTruthy();
    expect(within(dialog).getByText(/everyone using Quill can keep using it/)).toBeTruthy();
    expect(within(dialog).queryByText(/Your sign-in to Gmail expired/)).toBeNull();
  });

  it('a personal expired sign-in keeps “your” in the Reconnect dialog', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Your sign-in to Gmail expired/)).toBeTruthy();
  });

  it.each([
    [{ health: 'needs-reconnect', sharedSignIn: true } as const, 'Team sign-in expired'],
    [{ health: 'needs-reconnect' } as const, 'Your sign-in expired'],
  ])('Retry answering %j labels the row %s', async (answer, label) => {
    retryMock.mockResolvedValueOnce(answer);
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Can’t reach it' })).toBeNull());
    const named = screen.getAllByRole('button', { name: label });
    expect(named.some((b) => b.previousElementSibling?.textContent === 'Slack')).toBe(true);
  });

  it('leads an expired row’s menu with Reconnect, and an unreachable row’s with Retry', async () => {
    renderTab();
    let menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Reconnect',
      'View details',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    menu = await openMenu('Slack');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Retry',
      'View details',
      'Edit connector',
      'Remove from Quill',
    ]);
  });

  it('Retry runs exactly one check, and the row takes the health it answers', async () => {
    retryMock.mockResolvedValue({ health: 'ok' });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Can’t reach it' })).toBeNull());
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(retryMock).toHaveBeenCalledWith('a-quill', 'slack');
    // The list itself was not re-read to find out.
    expect(connectorsMock).toHaveBeenCalledTimes(1);
  });

  it('says so when Retry still cannot reach it, and when the check could not run', async () => {
    retryMock.mockResolvedValueOnce({ health: 'unreachable' });
    renderTab();
    let menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(await screen.findByText(/Still can’t reach Slack/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Can’t reach it' })).toBeTruthy();

    retryMock.mockRejectedValueOnce(new WorkspaceApiError('/agents/a-quill/connectors/slack/retry', 502));
    menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(await screen.findByText(/couldn’t check Slack just now/)).toBeTruthy();
  });

  it('Reconnect opens the sign-in for that connector on this agent, with no Retry check', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reconnect Gmail')).toBeTruthy();
    expect(await within(dialog).findByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(retryMock).not.toHaveBeenCalled();
  });

  it('Reconnect on a shared agent asks before signing in for everyone', async () => {
    connectorsMock.mockResolvedValue({ connectors: ERRORED, shared: true, connectorsSupported: true });
    renderTab();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/anyone who uses this shared agent act as you/)).toBeTruthy();
  });
});

describe("a connector a session can't fully load (TASK-745)", () => {
  const NOT_LOADED: AgentConnectorRow[] = [
    { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'not-loaded', removable: true },
    { id: 'gmail', name: 'Gmail', source: 'default', editable: false, health: 'not-loaded', removable: true },
  ];

  beforeEach(() => {
    connectorsMock.mockResolvedValue({ connectors: NOT_LOADED, shared: false, connectorsSupported: true });
  });

  it('wears the error icon after its name, saying what this person can do about it', async () => {
    renderTab();
    const editable = await screen.findByRole('button', {
      name: 'Couldn’t load it. Choose Edit connector to fix it.',
    });
    const locked = screen.getByRole('button', {
      name: 'Couldn’t load it. Ask a workspace admin to fix it.',
    });
    expect(editable.previousElementSibling?.textContent).toBe('Linear');
    expect(locked.previousElementSibling?.textContent).toBe('Gmail');
    expect(editable.querySelector('svg.lucide-circle-alert')).not.toBeNull();
    // No jargon reaches the person.
    expect(document.body.textContent ?? '').not.toMatch(/MCP|namespace/i);
  });

  it('shows the reason in a tooltip on keyboard focus', async () => {
    renderTab();
    const icon = await screen.findByRole('button', {
      name: 'Couldn’t load it. Choose Edit connector to fix it.',
    });
    icon.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Couldn’t load it. Choose Edit connector to fix it.');
  });

  it('offers no Reconnect or Retry — neither would fix it — and keeps Edit connector', async () => {
    renderTab();
    let menu = await openMenu('Linear');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Edit connector',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Remove from Quill',
    ]);
  });
});

describe("an agent whose model can't use connectors (TASK-761)", () => {
  const NOTICE = 'Quill’s model can’t use connectors yet, so nothing here applies to Quill for now.';

  it('says so plainly and offers no Add, while still listing what is there', async () => {
    connectorsMock.mockResolvedValue({ connectors: ROWS, shared: false, connectorsSupported: false });
    renderTab();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('replaces the empty state (and its "Add connector") with the same notice', async () => {
    connectorsMock.mockResolvedValue({ connectors: [], shared: false, connectorsSupported: false });
    renderTab();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText('No connectors yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add connector' })).toBeNull();
  });

  it('shows no notice for an agent that can use them', async () => {
    renderTab();
    await screen.findByText('Linear');
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });
});
