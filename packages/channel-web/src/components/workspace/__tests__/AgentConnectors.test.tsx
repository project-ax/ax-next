/**
 * The agent's connector list (TASK-739, connectors-rail slice 6).
 *
 * Pinned: rows are the connector NAME only; the ⋯ menu holds exactly what is
 * wired (View details, Edit permissions for every row, then Remove from
 * <agent>) — never the Settings connector editor ("Edit connector");
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
import { beginOAuth, getOAuthStatus } from '@/lib/connectors-oauth';
import type { AgentConnectorRow, AgentConnectorToolsRead } from '@/lib/workspace-types';
import type { AuthUser } from '@/lib/auth';
import { UserProvider } from '@/lib/user-context';
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
      connectorTools: vi.fn(),
      setToolVerdict: vi.fn(),
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

const connectorsMock = vi.mocked(workspaceApi.connectors);
const removeMock = vi.mocked(workspaceApi.removeConnector);
const railMock = vi.mocked(workspaceApi.rail);

const ROWS: AgentConnectorRow[] = [
  { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
  { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'ok', removable: true },
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

const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@example.com', name: 'Ada', role: 'admin' };

/** Rendered with no signed-in user unless one is given (useUser() → null). */
function renderTab(user?: AuthUser) {
  const tab = (
    <AgentRail detail={detail()} openPastId={null} onOpenPast={vi.fn()} tab="connectors" />
  );
  return render(user ? <UserProvider value={user}>{tab}</UserProvider> : tab);
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
  connectorsMock.mockResolvedValue({ connectors: ROWS, shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
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

const NS = 'c0123456789';
function toolsRead(): AgentConnectorToolsRead {
  return {
    connector: { id: 'linear', name: 'Linear', access: 'personal' },
    status: 'ok',
    checkedAt: '2026-10-02T10:00:00.000Z',
    possiblyIncomplete: false,
    tools: [
      {
        toolKey: `mcp.${NS}.Search issues`,
        title: 'Search issues',
        description: '',
        readOnly: true,
        outward: null,
        verdict: 'allow',
        ceiling: 'allow',
      },
      {
        toolKey: `mcp.${NS}.Create issue`,
        title: 'Create issue',
        description: '',
        readOnly: false,
        outward: true,
        verdict: 'hold',
        ceiling: 'allow',
      },
    ],
  };
}

describe('row menu', () => {
  it('offers Edit permissions — never Edit connector — and Remove from <agent> for an editable connector', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['View details', 'Edit permissions', 'Remove from Quill']);
    expect(within(menu).queryByText('Edit connector')).toBeNull();
    // A healthy row offers no fix.
    expect(within(menu).queryByText(/Reconnect|Retry/)).toBeNull();
  });

  it('offers Edit permissions for one this person cannot edit, too', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['View details', 'Edit permissions', 'Remove from Quill']);
    expect(within(menu).queryByText('Edit connector')).toBeNull();
  });

  it('Edit permissions opens a dialog listing the connector’s tools, and a change writes the verdict', async () => {
    const toolsMock = vi.mocked(workspaceApi.connectorTools);
    const setMock = vi.mocked(workspaceApi.setToolVerdict);
    toolsMock.mockResolvedValue(toolsRead());
    setMock.mockResolvedValue({
      tool: { toolKey: `mcp.${NS}.Create issue`, verdict: 'deny', ceiling: 'allow' },
    });
    renderTab();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit permissions' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit permissions/ });
    expect(within(dialog).getByText('Edit permissions · Gmail')).toBeTruthy();
    expect(toolsMock).toHaveBeenCalledWith('a-quill', 'gmail', false);
    expect(await within(dialog).findByText('Search issues')).toBeTruthy();
    expect(within(dialog).getByText('Create issue')).toBeTruthy();
    // Not the Settings connector editor.
    expect(within(dialog).queryByLabelText(/service name/i)).toBeNull();

    const create = within(dialog).getByRole('group', { name: 'What it may do with Create issue' });
    fireEvent.click(within(create).getByRole('radio', { name: 'Deny' }));
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith('a-quill', 'gmail', `mcp.${NS}.Create issue`, 'deny'),
    );
    await waitFor(() =>
      expect(
        within(create).getByRole('radio', { name: 'Deny' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('the details view’s menu has no Edit permissions — the view already is them', async () => {
    vi.mocked(workspaceApi.connectorTools).mockResolvedValue(toolsRead());
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View details' }));
    await screen.findByRole('button', { name: 'Connectors' });
    const inner = await openMenu('Linear');
    const items = within(inner).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).not.toContain('Edit permissions');
    expect(items).not.toContain('View details');
    expect(items).not.toContain('Edit connector');
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
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
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
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/Removed Linear\. Some of what you’d approved/)).toBeTruthy();
  });

  it('says it signed them out too when the connector was on none of their other agents', async () => {
    removeMock.mockResolvedValue({ removed: true, cleanup: 'complete', signedOut: true });
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText(
        'Removed Linear. None of your agents use it now, so we signed you out of it too — adding it again will ask you to sign in.',
      ),
    ).toBeTruthy();
  });

  it('says nothing about signing out on a plain remove', async () => {
    removeMock.mockResolvedValue({ removed: true, cleanup: 'complete' });
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Linear')).toBeNull());
    expect(screen.queryByText(/signed you out/)).toBeNull();
  });
});

// TASK-798 — on a team agent only the agent's owner (a team admin) or a
// workspace admin may add connectors, sign in ON the agent, or remove them.
// The server answers `manageable` (and `removable` per row, the same answer);
// for everyone else the rail does not offer those actions at all — not drawn
// and refused.
describe('a member on a team agent (TASK-798)', () => {
  const MEMBER_ROWS: AgentConnectorRow[] = [
    { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: false },
    { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'ask-owner', removable: false },
    { id: 'notion', name: 'Notion', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'add-key', removable: false },
  ];
  const ASK_OWNER = 'Ask the agent’s owner to sign in';
  const retryMock = vi.mocked(workspaceApi.retryConnector);

  function asMember(connectors: AgentConnectorRow[] = MEMBER_ROWS) {
    connectorsMock.mockResolvedValue({ connectors, shared: true, connectorsSupported: true, manageable: false, sharedCredentials: false });
  }

  it('offers no "+ Add"', async () => {
    asMember();
    renderTab();
    await screen.findByText('Linear');
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('offers no "Add connector" in the empty state, and does not tell them to add one', async () => {
    asMember([]);
    renderTab();
    expect(await screen.findByText('No connectors yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add connector' })).toBeNull();
    expect(screen.getByText(/Ask the agent’s owner/)).toBeTruthy();
    expect(screen.queryByText(/Connect a tool like Linear/)).toBeNull();
  });

  it('offers no Remove from <agent> at all — not even disabled', async () => {
    asMember();
    renderTab();
    const menu = await openMenu('Linear');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Edit permissions',
    ]);
    expect(within(menu).queryByText(/Remove from/)).toBeNull();
  });

  it('an ask-owner row wears the muted icon saying who can sign in, and offers no Sign in', async () => {
    asMember();
    renderTab();
    const icon = await screen.findByRole('button', { name: ASK_OWNER });
    expect(icon.previousElementSibling?.textContent).toBe('Gmail');
    expect(icon.className).toContain('text-muted-foreground');
    expect(icon.className).not.toContain('text-destructive');
    act(() => icon.focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe(ASK_OWNER);
    const menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Edit permissions',
    ]);
    expect(within(menu).queryByText(/Sign in/)).toBeNull();
  });

  it('still offers Add key — that key is their own', async () => {
    asMember();
    renderTab();
    const menu = await openMenu('Notion');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Add key',
      'View details',
      'Edit permissions',
    ]);
  });

  it('Retry finding nobody signed in points at the agent’s owner', async () => {
    asMember([
      { id: 'slack', name: 'Slack', source: 'attached', editable: false, health: 'unreachable', removable: false },
    ]);
    retryMock.mockResolvedValueOnce({ health: 'needs-sign-in', setup: 'ask-owner' });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(
      await screen.findByText(
        'Slack is reachable, but nobody has signed in yet. Ask the agent’s owner to sign in.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/workspace admin/)).toBeNull();
  });

  it('a team sign-in that expired offers no Reconnect, and says who can fix it', async () => {
    asMember([
      { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', sharedSignIn: true, removable: false },
    ]);
    renderTab();
    const reason = 'Team sign-in expired. Ask the agent’s owner to sign in again.';
    const icon = await screen.findByRole('button', { name: reason });
    act(() => icon.focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason);
    const menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Edit permissions',
    ]);
  });

  it('Retry finding the team sign-in expired points at the owner, not Reconnect', async () => {
    asMember([
      { id: 'slack', name: 'Slack', source: 'attached', editable: false, health: 'unreachable', removable: false },
    ]);
    retryMock.mockResolvedValueOnce({ health: 'needs-reconnect', sharedSignIn: true });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(
      await screen.findByText(
        'Slack is reachable, but its team sign-in expired. Ask the agent’s owner to sign in again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Choose Reconnect/)).toBeNull();
  });

  it('their own expired sign-in still offers Sign in again (TASK-774)', async () => {
    asMember([
      { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', removable: false },
    ]);
    renderTab();
    expect(await screen.findByRole('button', { name: 'Your sign-in expired' })).toBeTruthy();
    const menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Sign in again',
      'View details',
      'Edit permissions',
    ]);
  });

  it('the owner or an admin of the same team agent still gets Add, Sign in and Remove', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [
        { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
        { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'sign-in', removable: true },
      ],
      shared: true,
      connectorsSupported: true,
      manageable: true, sharedCredentials: true,
    });
    renderTab();
    await screen.findByText('Linear');
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    const menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Sign in',
      'View details',
      'Edit permissions',
      'Remove from Quill',
    ]);
  });
});

describe('empty state', () => {
  it('is a dashed card with the plug, the title, the copy and "Add connector"', async () => {
    connectorsMock.mockResolvedValue({ connectors: [], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
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
    { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', removable: true },
    { id: 'slack', name: 'Slack', source: 'attached', editable: true, health: 'unreachable', removable: true },
  ];
  const retryMock = vi.mocked(workspaceApi.retryConnector);

  beforeEach(() => {
    connectorsMock.mockResolvedValue({ connectors: ERRORED, shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
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
        { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', sharedSignIn: true, removable: true },
      ],
      shared: true,
      connectorsSupported: true, manageable: true, sharedCredentials: true,
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
    // A shared sign-in only exists on a team agent, seen here by its admin
    // (TASK-813: the one who may redo it).
    connectorsMock.mockResolvedValue({ connectors: ERRORED, shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
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
      'Edit permissions',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    menu = await openMenu('Slack');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Retry',
      'View details',
      'Edit permissions',
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
    // The team's shared sign-in (TASK-774: a member's own expiry offers
    // Sign in again instead, see below).
    connectorsMock.mockResolvedValue({
      connectors: ERRORED.map((r) => (r.id === 'gmail' ? { ...r, sharedSignIn: true as const } : r)),
      shared: true,
      connectorsSupported: true, manageable: true, sharedCredentials: true,
    });
    renderTab();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/anyone who uses this shared agent act as you/)).toBeTruthy();
  });
});

// TASK-774 — on a team agent, a member's OWN expired sign-in is fixed by a
// personal sign-in ("Sign in again"); Reconnect stays for the team's shared one.
describe('a team agent member’s own expired sign-in (TASK-774)', () => {
  const PERSONAL: AgentConnectorRow[] = [
    { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', removable: true },
  ];
  const SHARED: AgentConnectorRow[] = [
    { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', sharedSignIn: true, removable: true },
  ];
  const UNREACHABLE: AgentConnectorRow[] = [
    { id: 'slack', name: 'Slack', source: 'attached', editable: true, health: 'unreachable', removable: true },
  ];
  const beginMock = vi.mocked(beginOAuth);
  const statusMock = vi.mocked(getOAuthStatus);
  const retryMock = vi.mocked(workspaceApi.retryConnector);

  it('says “Your sign-in expired” and offers Sign in again, not Reconnect', async () => {
    connectorsMock.mockResolvedValue({ connectors: PERSONAL, shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    renderTab();
    expect(await screen.findByRole('button', { name: 'Your sign-in expired' })).toBeTruthy();
    const menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Sign in again',
      'View details',
      'Edit permissions',
      'Remove from Quill',
    ]);
  });

  // Slice 3 — every sign-in belongs to the agent. Until the menu is reworked
  // (Task 5), Sign in again opens the agent's own sign-in, as a sign-in-again.
  it('Sign in again signs in on THIS agent, as a sign-in-again', async () => {
    connectorsMock.mockResolvedValue({ connectors: PERSONAL, shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    beginMock.mockResolvedValue({ authorizationUrl: 'https://auth.example/authorize' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      renderTab();
      const menu = await openMenu('Gmail');
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in again' }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() =>
        expect(statusMock).toHaveBeenCalledWith({ connectorId: 'gmail', agentId: 'a-quill' }),
      );
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: /Reconnect|Connect with Gmail/ }));
      await waitFor(() => expect(beginMock).toHaveBeenCalledTimes(1));
      expect(beginMock).toHaveBeenCalledWith({ connectorId: 'gmail', agentId: 'a-quill', mode: 'sign-in-again' });
    } finally {
      open.mockRestore();
    }
  });

  it('a shared expired sign-in keeps Reconnect, which signs in on this agent', async () => {
    connectorsMock.mockResolvedValue({ connectors: SHARED, shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    beginMock.mockResolvedValue({ authorizationUrl: 'https://auth.example/authorize' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      renderTab();
      const menu = await openMenu('Gmail');
      expect(within(menu).queryByRole('menuitem', { name: 'Sign in again' })).toBeNull();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Reconnect' }));
      await waitFor(() => expect(beginMock).toHaveBeenCalledTimes(1));
      expect(beginMock).toHaveBeenCalledWith({ connectorId: 'gmail', agentId: 'a-quill', mode: 'sign-in-again' });
    } finally {
      open.mockRestore();
    }
  });

  it('a personal agent keeps Reconnect for its (always personal) sign-in', async () => {
    connectorsMock.mockResolvedValue({ connectors: PERSONAL, shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    renderTab();
    const menu = await openMenu('Gmail');
    expect(within(menu).getByRole('menuitem', { name: 'Reconnect' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Sign in again' })).toBeNull();
  });

  it('Retry finding the member’s own sign-in expired points at Sign in again, and the menu follows', async () => {
    connectorsMock.mockResolvedValue({ connectors: UNREACHABLE, shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    retryMock.mockResolvedValueOnce({ health: 'needs-reconnect' });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(await screen.findByText(/your sign-in expired\. Choose Sign in again/)).toBeTruthy();
    const next = await openMenu('Slack');
    expect(within(next).getByRole('menuitem', { name: 'Sign in again' })).toBeTruthy();
  });

  it('Retry finding the team’s sign-in expired points at Reconnect', async () => {
    connectorsMock.mockResolvedValue({ connectors: UNREACHABLE, shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    retryMock.mockResolvedValueOnce({ health: 'needs-reconnect', sharedSignIn: true });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(await screen.findByText(/Choose Reconnect to sign in again/)).toBeTruthy();
    const next = await openMenu('Slack');
    expect(within(next).getByRole('menuitem', { name: 'Reconnect' })).toBeTruthy();
  });
});

describe("a connector a session can't fully load (TASK-745)", () => {
  const NOT_LOADED: AgentConnectorRow[] = [
    { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'not-loaded', removable: true },
    { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'not-loaded', removable: true },
  ];

  beforeEach(() => {
    connectorsMock.mockResolvedValue({ connectors: NOT_LOADED, shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
  });

  const ASK_ADMIN = 'Couldn’t load it. Ask a workspace admin to fix it.';
  const FIX_IN_SETTINGS = 'Couldn’t load it. Fix it in Admin › Connectors.';

  it('wears the error icon after its name; someone who isn’t an admin is told to ask one — even for a connector they may edit', async () => {
    renderTab();
    const icons = await screen.findAllByRole('button', { name: ASK_ADMIN });
    expect(icons.map((i) => i.previousElementSibling?.textContent)).toEqual(['Linear', 'Gmail']);
    expect(icons[0]!.querySelector('svg.lucide-circle-alert')).not.toBeNull();
    // The old advice pointed at a menu item the rail no longer has.
    expect(screen.queryByRole('button', { name: /Edit connector/ })).toBeNull();
    // No jargon reaches the person.
    expect(document.body.textContent ?? '').not.toMatch(/MCP|namespace/i);
  });

  it('a workspace admin is pointed at Admin › Connectors, whether or not the row is editable', async () => {
    renderTab(ADMIN);
    const icons = await screen.findAllByRole('button', { name: FIX_IN_SETTINGS });
    expect(icons.map((i) => i.previousElementSibling?.textContent)).toEqual(['Linear', 'Gmail']);
    expect(screen.queryByRole('button', { name: ASK_ADMIN })).toBeNull();
  });

  it('shows the reason in a tooltip on keyboard focus', async () => {
    renderTab(ADMIN);
    const [icon] = await screen.findAllByRole('button', { name: FIX_IN_SETTINGS });
    icon!.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(FIX_IN_SETTINGS);
  });

  it('offers no Reconnect or Retry — neither would fix it — and no Edit connector', async () => {
    renderTab();
    let menu = await openMenu('Linear');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Edit permissions',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'View details',
      'Edit permissions',
      'Remove from Quill',
    ]);
  });
});

describe("an agent whose model can't use connectors (TASK-761)", () => {
  const NOTICE = 'Quill’s model can’t use connectors yet, so nothing here applies to Quill for now.';

  it('says so plainly and offers no Add, while still listing what is there', async () => {
    connectorsMock.mockResolvedValue({ connectors: ROWS, shared: false, connectorsSupported: false, manageable: true, sharedCredentials: false });
    renderTab();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('replaces the empty state (and its "Add connector") with the same notice', async () => {
    connectorsMock.mockResolvedValue({ connectors: [], shared: false, connectorsSupported: false, manageable: true, sharedCredentials: false });
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
