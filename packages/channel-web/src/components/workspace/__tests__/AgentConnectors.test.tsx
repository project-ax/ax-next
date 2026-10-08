/**
 * The agent's connector list (TASK-739, connectors-rail slice 6).
 *
 * Pinned: rows are the connector NAME only; slice 3's row menu — Edit (the
 * details view) and Remove from <agent>, led by Sign in again on a row whose
 * sign-in expired or is missing, or Add key on a row whose key is missing —
 * for whoever may choose the agent's account; a plain member gets only a
 * read-only View details. The old flow's Retry, Reconnect, Team key and
 * Remove team sign-in are never drawn. Removing asks first, never drops a
 * row the server still has, and never says anyone was signed out. The empty
 * state; "+ Add" / "Add connector" open the Add subview (TASK-740).
 *
 * TASK-741 (slice 8): an errored row wears ONE red icon after its name — no
 * inline error text — whose reason is its accessible name and a tooltip that
 * opens on keyboard focus too.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** Every menu item's text, in order. */
async function menuItems(name: string) {
  const menu = await openMenu(name);
  return within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent);
}

/** Slice 3 — the old flow's items, which no state may ever draw again. */
const GONE = /Retry|Reconnect|Team key|Remove team sign-in|View details|Edit permissions/;

describe('row menu (slice 3: Edit and Remove, plus a fix when needed)', () => {
  it('a healthy row’s menu is exactly Edit and Remove from <agent>', async () => {
    renderTab();
    expect(await menuItems('Linear')).toEqual(['Edit', 'Remove from Quill']);
  });

  it('is the same for a connector this person cannot edit — never the Settings editor', async () => {
    renderTab();
    const menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Edit',
      'Remove from Quill',
    ]);
    expect(within(menu).queryByText('Edit connector')).toBeNull();
  });

  it('Edit opens the details view, whose per-tool choices write the verdict', async () => {
    const toolsMock = vi.mocked(workspaceApi.connectorTools);
    const setMock = vi.mocked(workspaceApi.setToolVerdict);
    toolsMock.mockResolvedValue(toolsRead());
    setMock.mockResolvedValue({
      tool: { toolKey: `mcp.${NS}.Create issue`, verdict: 'deny', ceiling: 'allow' },
    });
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    // The details subview, not a dialog.
    await screen.findByRole('button', { name: 'Connectors' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toolsMock).toHaveBeenCalledWith('a-quill', 'linear', false);
    expect(await screen.findByText('Search issues')).toBeTruthy();
    const create = screen.getByRole('group', { name: 'What it may do with Create issue' });
    fireEvent.click(within(create).getByRole('radio', { name: 'Deny' }));
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith('a-quill', 'linear', `mcp.${NS}.Create issue`, 'deny'),
    );
  });

  it('the details view’s own menu has no Edit — the view already is it', async () => {
    vi.mocked(workspaceApi.connectorTools).mockResolvedValue(toolsRead());
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('button', { name: 'Connectors' });
    expect(await menuItems('Linear')).toEqual(['Remove from Quill']);
  });

  it('an expired row leads with Sign in again', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ ...ROWS[1]!, health: 'needs-reconnect' }],
      shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false,
    });
    renderTab();
    expect(await menuItems('Gmail')).toEqual(['Sign in again', 'Edit', 'Remove from Quill']);
  });

  it('a row never signed in leads with Sign in again too', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ ...ROWS[1]!, health: 'needs-sign-in', setup: 'sign-in' }],
      shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false,
    });
    renderTab();
    expect(await menuItems('Gmail')).toEqual(['Sign in again', 'Edit', 'Remove from Quill']);
  });

  it('a missing key leads with Add key', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ ...ROWS[1]!, health: 'needs-sign-in', setup: 'add-key' }],
      shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false,
    });
    renderTab();
    expect(await menuItems('Gmail')).toEqual(['Add key', 'Edit', 'Remove from Quill']);
  });

  it('an unreachable row offers no fix: there is nothing to retry from here', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ ...ROWS[1]!, health: 'unreachable' }],
      shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false,
    });
    renderTab();
    expect(await screen.findByRole('button', { name: 'Can’t reach it' })).toBeTruthy();
    expect(await menuItems('Gmail')).toEqual(['Edit', 'Remove from Quill']);
  });

  it.each([
    ['ok', {}],
    ['needs-reconnect', {}],
    ['needs-reconnect (team)', { sharedSignIn: true as const }],
    ['needs-sign-in', { setup: 'sign-in' as const }],
    ['needs-sign-in', { setup: 'add-key' as const }],
    ['needs-sign-in', { setup: 'ask-admin' as const }],
    ['unreachable', {}],
    ['not-loaded', {}],
  ])('never draws Retry, Reconnect, Team key or Remove team sign-in (%s %j)', async (label, extra) => {
    const health = label.split(' ')[0] as AgentConnectorRow['health'];
    for (const shared of [false, true]) {
      for (const sharedCredentials of shared ? [true, false] : [false]) {
        cleanup();
        connectorsMock.mockResolvedValue({
          connectors: [{ ...ROWS[0]!, health, ...extra }],
          shared,
          connectorsSupported: true,
          manageable: true,
          sharedCredentials,
        });
        renderTab();
        const menu = await openMenu('Linear');
        expect(menu.textContent ?? '').not.toMatch(GONE);
      }
    }
  });
});

// Slice 3 — "Sign in again" is the agent's own sign-in: the popup begins as a
// sign-in-again on THIS agent, and a success re-reads the list.
describe('Sign in again', () => {
  const beginMock = vi.mocked(beginOAuth);
  const statusMock = vi.mocked(getOAuthStatus);

  it('begins a sign-in-again on this agent, and finishing it re-reads the list', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ ...ROWS[1]!, health: 'needs-reconnect' }],
      shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false,
    });
    beginMock.mockResolvedValue({ authorizationUrl: 'https://auth.example/authorize' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      renderTab();
      const menu = await openMenu('Gmail');
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in again' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Sign in to Gmail again')).toBeTruthy();
      await waitFor(() =>
        expect(statusMock).toHaveBeenCalledWith({ connectorId: 'gmail', agentId: 'a-quill' }),
      );
      fireEvent.click(await within(dialog).findByRole('button', { name: /Reconnect|Connect with Gmail/ }));
      await waitFor(() => expect(beginMock).toHaveBeenCalledTimes(1));
      expect(beginMock).toHaveBeenCalledWith({ connectorId: 'gmail', agentId: 'a-quill', mode: 'sign-in-again' });
    } finally {
      open.mockRestore();
    }
  });

  it('on a team agent, its admin is asked first — everyone will act as the signer', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ ...ROWS[1]!, health: 'needs-reconnect', sharedSignIn: true }],
      shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true,
    });
    renderTab();
    expect(await screen.findByRole('button', { name: 'Team sign-in expired' })).toBeTruthy();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in again' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/everyone using Quill uses Gmail as you/)).toBeTruthy();
    expect(await within(dialog).findByText(/anyone who uses this shared agent act as you/)).toBeTruthy();
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

  // Slice 3 — Remove deletes the agent's own sign-in; nobody is signed out of
  // anything, so there is nothing to say about it — even if an old server says so.
  it('shows no signed-out notice', async () => {
    removeMock.mockResolvedValue({ removed: true, cleanup: 'complete', signedOut: true } as never);
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Quill' }));
    connectorsMock.mockResolvedValue({ connectors: [ROWS[1]!], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Linear')).toBeNull());
    expect(screen.queryByText(/signed you out|sign you out/)).toBeNull();
  });
});

// TASK-798 / slice 3 — on a team agent the account is the agent's, and only
// a team admin may choose it: everyone else sees who it acts as, with no
// actions. A plain member keeps a read-only View details.
describe('a member on a team agent', () => {
  const MEMBER_ROWS: AgentConnectorRow[] = [
    { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: false },
    { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'ask-owner', removable: false },
    { id: 'notion', name: 'Notion', source: 'attached', editable: false, health: 'needs-reconnect', removable: false },
    { id: 'jira', name: 'Jira', source: 'attached', editable: false, health: 'needs-reconnect', sharedSignIn: true, removable: false },
    // An older server may still say add-key to a member: the rail decides too.
    { id: 'brave', name: 'Brave', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'add-key', removable: false },
  ];
  const ASK_OWNER = 'Ask the agent’s owner to set it up';
  const EXPIRED_ASK_OWNER = 'Sign-in expired. Ask the agent’s owner to sign in again.';

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

  it.each(['Linear', 'Gmail', 'Notion', 'Jira', 'Brave'])(
    '%s: only a read-only View details — no Sign in again, Add key or Remove',
    async (name) => {
      asMember();
      renderTab();
      expect(await menuItems(name)).toEqual(['View details']);
    },
  );

  it('an ask-owner row wears the muted icon saying who can set it up', async () => {
    asMember();
    renderTab();
    const icon = await screen.findByRole('button', { name: ASK_OWNER });
    expect(icon.previousElementSibling?.textContent).toBe('Gmail');
    expect(icon.className).toContain('text-muted-foreground');
    expect(icon.className).not.toContain('text-destructive');
    act(() => icon.focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe(ASK_OWNER);
  });

  it('an expired sign-in — theirs or the team’s — says who can fix it', async () => {
    asMember();
    renderTab();
    const icons = await screen.findAllByRole('button', { name: EXPIRED_ASK_OWNER });
    expect(icons.map((i) => i.previousElementSibling?.textContent)).toEqual(['Notion', 'Jira']);
  });

  it('View details opens the details view, with no setup button', async () => {
    asMember([MEMBER_ROWS[4]!]);
    vi.mocked(workspaceApi.connectorTools).mockResolvedValue(toolsRead());
    renderTab();
    const menu = await openMenu('Brave');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View details' }));
    await screen.findByRole('button', { name: 'Connectors' });
    expect(screen.queryByRole('button', { name: /^(Sign in|Add key)$/ })).toBeNull();
    // Nothing for them in the details view's menu either: no ⋯ at all.
    expect(screen.queryByRole('button', { name: 'Actions for Brave' })).toBeNull();
  });

  it('a workspace admin who is not the team’s admin may remove, but not sign in', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [{ id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-reconnect', sharedSignIn: true, removable: true }],
      shared: true, connectorsSupported: true, manageable: true, sharedCredentials: false,
    });
    renderTab();
    expect(await screen.findByRole('button', { name: EXPIRED_ASK_OWNER })).toBeTruthy();
    expect(await menuItems('Gmail')).toEqual(['Edit', 'Remove from Quill']);
  });

  it('the team’s admin gets Add, Sign in again, Add key and Remove', async () => {
    connectorsMock.mockResolvedValue({
      connectors: [
        { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
        { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'sign-in', removable: true },
        { id: 'brave', name: 'Brave', source: 'attached', editable: false, health: 'needs-sign-in', setup: 'add-key', removable: true },
      ],
      shared: true,
      connectorsSupported: true,
      manageable: true, sharedCredentials: true,
    });
    renderTab();
    await screen.findByText('Linear');
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(await menuItems('Gmail')).toEqual(['Sign in again', 'Edit', 'Remove from Quill']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await menuItems('Brave')).toEqual(['Add key', 'Edit', 'Remove from Quill']);
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
  it('names a shared expired sign-in as the team’s', async () => {
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

  it('offers no fix — signing in again would not fix it — and no Edit connector', async () => {
    renderTab();
    let menu = await openMenu('Linear');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Edit',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    menu = await openMenu('Gmail');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Edit',
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
