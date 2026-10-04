/**
 * A connector nobody has set up yet (TASK-795).
 *
 * Pinned: a `needs-sign-in` row wears a NEUTRAL icon (not the red error one)
 * whose reason is its accessible name and a tooltip on hover AND keyboard
 * focus; the `⋯` menu leads with the row's setup — **Sign in** (OAuth) or
 * **Add key** (API key) — and offers nothing for `ask-admin`; Sign in opens a
 * dialog around the OAuth widget on THIS agent, Add key opens the Settings key
 * dialog, and finishing either re-reads the list. The details view says the
 * same word and offers the same button.
 *
 * The OAuth widget and the key dialog are stubbed: their own tests pin what
 * they do; here we pin that the rail hands them the right connector and
 * listens for the finish.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, type AgentDetail } from '@/lib/workspace-api';
import type { AgentConnectorRow, AgentConnectorToolsRead } from '@/lib/workspace-types';
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

vi.mock('@/components/settings/ConnectorOAuthConnect', () => ({
  ConnectorOAuthConnect: (props: {
    connectorId: string;
    agentId?: string;
    requiresConsent?: boolean;
    onConnected?: () => void;
  }) => (
    <div
      data-testid="oauth-connect"
      data-connector={props.connectorId}
      data-agent={props.agentId ?? ''}
      data-consent={String(props.requiresConsent ?? false)}
    >
      <button type="button" onClick={() => props.onConnected?.()}>
        Finish sign-in
      </button>
    </div>
  ),
}));

vi.mock('@/components/settings/ConnectorConnectDialog', () => ({
  ConnectorConnectDialog: (props: {
    connectorId: string;
    connectorName: string;
    isAdmin: boolean;
    open: boolean;
    onConnected: () => void;
  }) =>
    props.open ? (
      <div
        data-testid="key-dialog"
        data-connector={props.connectorId}
        data-name={props.connectorName}
        data-admin={String(props.isAdmin)}
      >
        <button type="button" onClick={props.onConnected}>
          Finish key
        </button>
      </div>
    ) : null,
}));

const connectorsMock = vi.mocked(workspaceApi.connectors);
const retryMock = vi.mocked(workspaceApi.retryConnector);

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

const SIGN_IN = row({ id: 'linear', name: 'Linear', health: 'needs-sign-in', setup: 'sign-in' });
const ADD_KEY = row({ id: 'brave', name: 'Brave', health: 'needs-sign-in', setup: 'add-key' });
const ASK_ADMIN = row({ id: 'acme', name: 'Acme', health: 'needs-sign-in', setup: 'ask-admin' });
const OK = row({ id: 'gmail', name: 'Gmail', health: 'ok' });
const UNREACHABLE = row({ id: 'slack', name: 'Slack', health: 'unreachable' });

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

function toolsRead(id: string, name: string): AgentConnectorToolsRead {
  return {
    connector: { id, name, access: 'personal' },
    status: 'needs-auth',
    checkedAt: '2026-10-02T10:00:00.000Z',
    possiblyIncomplete: false,
    tools: [],
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

async function menuItems(name: string) {
  const menu = await openMenu(name);
  return within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent);
}

function list(rows: AgentConnectorRow[], shared = false) {
  connectorsMock.mockResolvedValue({ connectors: rows, shared, connectorsSupported: true, manageable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceApi.rail).mockResolvedValue(rail());
  vi.mocked(workspaceApi.abilities).mockResolvedValue({
    abilities: { webSearch: true, readPages: true, runCode: true },
  });
  vi.mocked(workspaceApi.connectorTools).mockImplementation(async (_a, id) =>
    toolsRead(id, id),
  );
  list([SIGN_IN, ADD_KEY, ASK_ADMIN, OK]);
});

describe('the row icon', () => {
  it.each([
    ['Linear', 'Not signed in yet'],
    ['Brave', 'No key added yet'],
    ['Acme', 'Needs a key from a workspace admin'],
  ])('%s wears a neutral icon named “%s”, right after its name', async (name, reason) => {
    renderTab();
    const icon = await screen.findByRole('button', { name: reason });
    expect(icon.previousElementSibling?.textContent).toBe(name);
    expect(icon.querySelector('svg.lucide-circle-alert')).not.toBeNull();
    // Nothing is broken — it just isn't set up yet. Not the red error icon.
    expect(icon.className).toContain('text-muted-foreground');
    expect(icon.className).not.toContain('text-destructive');
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('keeps the red icon for a real error beside it', async () => {
    list([SIGN_IN, UNREACHABLE]);
    renderTab();
    const icon = await screen.findByRole('button', { name: 'Can’t reach it' });
    expect(icon.className).toContain('text-destructive');
    const neutral = screen.getByRole('button', { name: 'Not signed in yet' });
    expect(neutral.className).not.toContain('text-destructive');
  });

  it('shows the reason in a tooltip on keyboard focus', async () => {
    renderTab();
    const icon = await screen.findByRole('button', { name: 'Not signed in yet' });
    icon.focus();
    expect((await screen.findByRole('tooltip')).textContent).toBe('Not signed in yet');
  });

  it('shows the reason in a tooltip on hover', async () => {
    renderTab();
    const icon = await screen.findByRole('button', { name: 'Needs a key from a workspace admin' });
    fireEvent.pointerMove(icon, { pointerType: 'mouse' });
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Needs a key from a workspace admin',
    );
  });
});

describe('the row menu', () => {
  it('leads with Sign in for a sign-in row, and offers no Retry or Reconnect', async () => {
    renderTab();
    expect(await menuItems('Linear')).toEqual(['Sign in', 'View details', 'Remove from Quill']);
  });

  it('leads with Add key for a key row', async () => {
    renderTab();
    expect(await menuItems('Brave')).toEqual(['Add key', 'View details', 'Remove from Quill']);
  });

  it('offers no setup for a row only an admin can set up — the icon says who can', async () => {
    renderTab();
    expect(
      await screen.findByRole('button', { name: 'Needs a key from a workspace admin' }),
    ).toBeTruthy();
    expect(await menuItems('Acme')).toEqual(['View details', 'Remove from Quill']);
  });

  it('offers no setup on a healthy row beside one that has it', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    expect(within(menu).getByRole('menuitem', { name: 'Sign in' })).toBeTruthy();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await menuItems('Gmail')).toEqual(['View details', 'Remove from Quill']);
  });
});

describe('Sign in', () => {
  it('opens a sign-in on THIS agent, and finishing it re-reads the list', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Sign in to Linear')).toBeTruthy();
    expect(within(dialog).getByText('Sign in and Quill can use Linear for you.')).toBeTruthy();
    const widget = within(dialog).getByTestId('oauth-connect');
    expect(widget.dataset.connector).toBe('linear');
    expect(widget.dataset.agent).toBe('a-quill');
    expect(widget.dataset.consent).toBe('false');
    const reads = connectorsMock.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(connectorsMock.mock.calls.length).toBeGreaterThan(reads));
  });

  it('on a team agent, says everyone will use it as you, and asks first', async () => {
    list([SIGN_IN], true);
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Signing in here lets everyone using Quill use Linear as you.'),
    ).toBeTruthy();
    expect(within(dialog).getByTestId('oauth-connect').dataset.consent).toBe('true');
  });
});

describe('Add key', () => {
  it('opens the key dialog for that connector, and finishing it re-reads the list', async () => {
    renderTab();
    const menu = await openMenu('Brave');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add key' }));
    const dialog = await screen.findByTestId('key-dialog');
    expect(dialog.dataset.connector).toBe('brave');
    expect(dialog.dataset.name).toBe('Brave');
    expect(dialog.dataset.admin).toBe('false');
    const reads = connectorsMock.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish key' }));
    await waitFor(() => expect(connectorsMock.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByTestId('key-dialog')).toBeNull();
  });
});

describe('Retry finding nobody signed in', () => {
  it.each([
    ['sign-in', /Slack is reachable, but nobody has signed in yet\. Choose Sign in to set it up\./, 'Sign in'],
    ['add-key', /Slack is reachable, but no key has been added yet\. Choose Add key to set it up\./, 'Add key'],
  ] as const)('setup %s says so and the menu follows', async (setup, note, item) => {
    list([UNREACHABLE]);
    retryMock.mockResolvedValueOnce({ health: 'needs-sign-in', setup });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(await screen.findByText(note)).toBeTruthy();
    const next = await openMenu('Slack');
    expect(within(next).getAllByRole('menuitem')[0]?.textContent).toBe(item);
  });

  it('ask-admin points at a workspace admin', async () => {
    list([UNREACHABLE]);
    retryMock.mockResolvedValueOnce({ health: 'needs-sign-in', setup: 'ask-admin' });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(
      await screen.findByText(/Slack is reachable, but it needs a key from a workspace admin\./),
    ).toBeTruthy();
  });
});

describe('the details view', () => {
  async function openDetails(name: string) {
    const menu = await openMenu(name);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View details' }));
    await screen.findByRole('button', { name: 'Connectors' });
  }

  it('says “Not signed in yet” (muted) and its Sign in button opens the same sign-in', async () => {
    renderTab();
    await openDetails('Linear');
    const word = await screen.findByText('Not signed in yet');
    expect(word.closest('p')?.className).toContain('text-muted-foreground');
    expect(word.closest('p')?.className).not.toContain('text-destructive');
    expect(screen.queryByText('Sign-in needed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Sign in to Linear')).toBeTruthy();
    expect(within(dialog).getByTestId('oauth-connect').dataset.agent).toBe('a-quill');
  });

  it('says “No key added yet” and its Add key button opens the key dialog', async () => {
    renderTab();
    await openDetails('Brave');
    expect(await screen.findByText('No key added yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect((await screen.findByTestId('key-dialog')).dataset.connector).toBe('brave');
  });

  it('never tells someone who never signed in to sign in “again” to see its tools', async () => {
    renderTab();
    await openDetails('Linear');
    expect(await screen.findByText('Once it’s set up, all of its tools show here.')).toBeTruthy();
    expect(screen.queryByText(/sign in to this connector again/i)).toBeNull();
  });

  it('offers no button when only an admin can set it up', async () => {
    renderTab();
    await openDetails('Acme');
    expect(await screen.findByText('Needs a key from a workspace admin')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Sign in|Add key)$/ })).toBeNull();
  });
});
