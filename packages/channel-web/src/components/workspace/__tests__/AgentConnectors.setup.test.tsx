/**
 * A connector nobody has set up yet (TASK-795, slice 3).
 *
 * Pinned: a `needs-sign-in` row wears a NEUTRAL icon (not the red error one)
 * whose reason is its accessible name and a tooltip on hover AND keyboard
 * focus; the `⋯` menu leads with the row's fix — **Sign in** (OAuth; never
 * signed in, so not "again") or **Add key** (the agent's own key) — and
 * offers nothing for `ask-admin`; Sign in opens a dialog around the OAuth
 * widget on THIS agent, as a
 * sign-in-again (it is already on the agent); Add key opens the agent key
 * dialog; finishing either re-reads the list. The details view says the same
 * word and offers the same button.
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
      connectorTools: vi.fn(),
      setToolVerdict: vi.fn(),
    },
  };
});

vi.mock('@/components/settings/ConnectorOAuthConnect', () => ({
  ConnectorOAuthConnect: (props: {
    connectorId: string;
    agentId: string;
    mode: string;
    requiresConsent?: boolean;
    onConnected?: () => void;
  }) => (
    <div
      data-testid="oauth-connect"
      data-connector={props.connectorId}
      data-agent={props.agentId}
      data-mode={props.mode}
      data-consent={String(props.requiresConsent ?? false)}
    >
      <button type="button" onClick={() => props.onConnected?.()}>
        Finish sign-in
      </button>
    </div>
  ),
}));

vi.mock('../AgentKeyDialog', () => ({
  AgentKeyDialog: (props: {
    agentId: string;
    connectorId: string;
    connectorName: string;
    onSaved: () => void;
  }) => (
    <div
      data-testid="key-dialog"
      data-agent={props.agentId}
      data-connector={props.connectorId}
      data-name={props.connectorName}
    >
      <button type="button" onClick={props.onSaved}>
        Finish key
      </button>
    </div>
  ),
}));

const connectorsMock = vi.mocked(workspaceApi.connectors);

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
const EDIT_REMOVE = ['Edit', 'Remove from Quill'];

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
  connectorsMock.mockResolvedValue({ connectors: rows, shared, connectorsSupported: true, manageable: true, sharedCredentials: shared });
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
  // Ruling: a row that was never signed in says "Sign in"; only an expired
  // one says "Sign in again".
  it('leads with Sign in for a row never signed in', async () => {
    renderTab();
    expect(await menuItems('Linear')).toEqual(['Sign in', ...EDIT_REMOVE]);
  });

  it('leads with Add key for a key row', async () => {
    renderTab();
    expect(await menuItems('Brave')).toEqual(['Add key', ...EDIT_REMOVE]);
  });

  it('offers no setup for a row only an admin can set up — the icon says who can', async () => {
    renderTab();
    expect(
      await screen.findByRole('button', { name: 'Needs a key from a workspace admin' }),
    ).toBeTruthy();
    expect(await menuItems('Acme')).toEqual(EDIT_REMOVE);
  });

  it('offers no setup on a healthy row beside one that has it', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    expect(within(menu).getByRole('menuitem', { name: 'Sign in' })).toBeTruthy();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await menuItems('Gmail')).toEqual(EDIT_REMOVE);
  });
});

describe('Sign in (a row never signed in)', () => {
  it('opens a sign-in-again on THIS agent, and finishing it re-reads the list', async () => {
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Sign in to Linear' })).toBeTruthy();
    expect(within(dialog).queryByText(/again/)).toBeNull();
    expect(within(dialog).getByText('Sign in and Quill can use Linear.')).toBeTruthy();
    const widget = within(dialog).getByTestId('oauth-connect');
    expect(widget.dataset.connector).toBe('linear');
    expect(widget.dataset.agent).toBe('a-quill');
    expect(widget.dataset.mode).toBe('sign-in-again');
    expect(widget.dataset.consent).toBe('false');
    const reads = connectorsMock.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(connectorsMock.mock.calls.length).toBeGreaterThan(reads));
  });

  it('on a team agent, says your account is used for everyone on it, and asks first', async () => {
    list([SIGN_IN], true);
    renderTab();
    const menu = await openMenu('Linear');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Sign in, and Quill will use your Linear account for everyone who uses this agent.'),
    ).toBeTruthy();
    expect(within(dialog).getByTestId('oauth-connect').dataset.consent).toBe('true');
  });
});

describe('Add key', () => {
  it('opens the agent key dialog for that connector, and finishing it re-reads the list', async () => {
    renderTab();
    const menu = await openMenu('Brave');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add key' }));
    const dialog = await screen.findByTestId('key-dialog');
    expect(dialog.dataset.connector).toBe('brave');
    expect(dialog.dataset.name).toBe('Brave');
    expect(dialog.dataset.agent).toBe('a-quill');
    const reads = connectorsMock.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish key' }));
    await waitFor(() => expect(connectorsMock.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByTestId('key-dialog')).toBeNull();
  });
});

describe('the details view', () => {
  async function openDetails(name: string) {
    const menu = await openMenu(name);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
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
    expect(within(dialog).getByRole('heading', { name: 'Sign in to Linear' })).toBeTruthy();
    const widget = within(dialog).getByTestId('oauth-connect');
    expect(widget.dataset.agent).toBe('a-quill');
    expect(widget.dataset.mode).toBe('sign-in-again');
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

  // TASK-812 — found twice by the TASK-800 walk: right after a sign-in the
  // list said the connector was fine, but the details view still said
  // "Sign-in needed" (and "sign in again to see its tools") until a reload.
  // Its tool read was the one from BEFORE the sign-in, and an unforced
  // re-read is answered from the server's cache of that same old check —
  // which is exactly what this mock does.
  it('shows the signed-in state right after a sign-in, with no reload', async () => {
    const toolsMock = vi.mocked(workspaceApi.connectorTools);
    toolsMock.mockImplementation(async (_a, id, refresh) =>
      refresh === true
        ? { ...toolsRead(id, 'Linear'), status: 'ok', tools: [] }
        : toolsRead(id, 'Linear'),
    );
    renderTab();
    await openDetails('Linear');
    await screen.findByText('Not signed in yet');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog');
    list([row({ id: 'linear', name: 'Linear', health: 'ok' }), ADD_KEY, ASK_ADMIN, OK]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish sign-in' }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.queryByText('Sign-in needed')).toBeNull();
    expect(screen.queryByText(/sign in to this connector again/i)).toBeNull();
    expect(screen.queryByText('Not signed in yet')).toBeNull();
    expect(toolsMock).toHaveBeenLastCalledWith('a-quill', 'linear', true);
    // One read on open, one forced re-read after the sign-in — no more.
    expect(toolsMock.mock.calls.filter((c) => c[1] === 'linear')).toHaveLength(2);
  });

  it('shows the key as set up right after adding it, with no reload', async () => {
    const toolsMock = vi.mocked(workspaceApi.connectorTools);
    toolsMock.mockImplementation(async (_a, id, refresh) =>
      refresh === true
        ? { ...toolsRead(id, 'Brave'), status: 'ok', tools: [] }
        : toolsRead(id, 'Brave'),
    );
    renderTab();
    await openDetails('Brave');
    await screen.findByText('No key added yet');
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    const dialog = await screen.findByTestId('key-dialog');
    list([SIGN_IN, row({ id: 'brave', name: 'Brave', health: 'ok' }), ASK_ADMIN, OK]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish key' }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.queryByText('Sign-in needed')).toBeNull();
  });

  it('offers no button when only an admin can set it up', async () => {
    renderTab();
    await openDetails('Acme');
    expect(await screen.findByText('Needs a key from a workspace admin')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Sign in|Add key)$/ })).toBeNull();
  });
});

describe('which account the agent uses (slice 4)', () => {
  const signedIn = (account: string | null) => ({
    account,
    byName: null,
    byYou: true,
    at: '2026-10-07T12:00:00.000Z',
  });
  const EXPIRED = (account: string | null) =>
    row({ id: 'gmail', name: 'Gmail', health: 'needs-reconnect', signedIn: signedIn(account) });

  it('a row shows only the name; the account is in a tooltip on hover', async () => {
    list([row({ id: 'gmail', name: 'Gmail', signedIn: signedIn('bob@x.com') }), SIGN_IN]);
    renderTab();
    const name = await screen.findByTestId('connector-name-gmail');
    // The row draws the name alone; the account is for screen readers only.
    const shown = [...name.childNodes].filter(
      (n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')),
    );
    expect(shown.map((n) => n.textContent).join('')).toBe('Gmail');
    expect(name.querySelector('.sr-only')?.textContent).toBe(', signed in as bob@x.com');
    fireEvent.pointerMove(name, { pointerType: 'mouse' });
    expect((await screen.findByRole('tooltip')).textContent).toBe('bob@x.com');
  });

  it('the account tooltip opens on keyboard focus too', async () => {
    list([row({ id: 'gmail', name: 'Gmail', signedIn: signedIn('bob@x.com') })]);
    renderTab();
    const name = await screen.findByTestId('connector-name-gmail');
    expect(name.getAttribute('tabindex')).toBe('0');
    name.focus();
    expect((await screen.findByRole('tooltip')).textContent).toBe('bob@x.com');
  });

  it('a row with no recorded account is just its name, with no tooltip', async () => {
    list([row({ id: 'gmail', name: 'Gmail', signedIn: { account: null, byName: null, byYou: false, at: null } })]);
    renderTab();
    const name = await screen.findByTestId('connector-name-gmail');
    expect(name.textContent).toBe('Gmail');
    expect(name.getAttribute('tabindex')).toBeNull();
    fireEvent.pointerMove(name, { pointerType: 'mouse' });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('renders a hostile account as literal text, never markup', async () => {
    const evil = '<img src=x onerror=alert(1)>\u202Egro.live';
    list([row({ id: 'gmail', name: 'Gmail', signedIn: signedIn(evil) })]);
    renderTab();
    const name = await screen.findByTestId('connector-name-gmail');
    expect(name.querySelector('.sr-only')?.textContent).toBe(`, signed in as ${evil}`);
    expect(name.querySelector('bdi')?.textContent).toBe(evil);
    expect(name.querySelector('img')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('the row menu starts with the account, as a plain label above the actions', async () => {
    list([row({ id: 'gmail', name: 'Gmail', signedIn: signedIn('bob@x.com') })]);
    renderTab();
    const menu = await openMenu('Gmail');
    const label = within(menu).getByTestId('row-menu-account');
    expect(label.textContent).toBe('bob@x.com');
    // First thing in the menu, and not something you can pick.
    expect(menu.firstElementChild?.contains(label) || menu.firstElementChild === label).toBe(true);
    expect(label.getAttribute('role')).not.toBe('menuitem');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).not.toContain('bob@x.com');
    // Provider text isolated, as on the row.
    expect(label.querySelector('bdi')?.textContent).toBe('bob@x.com');
  });

  it('a row menu with no recorded account has no account label', async () => {
    list([row({ id: 'gmail', name: 'Gmail', signedIn: { account: null, byName: null, byYou: false, at: null } })]);
    renderTab();
    const menu = await openMenu('Gmail');
    expect(within(menu).queryByTestId('row-menu-account')).toBeNull();
  });

  async function signInAgainAs(before: string | null, after: string | null) {
    list([EXPIRED(before)]);
    renderTab();
    const menu = await openMenu('Gmail');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in again' }));
    const dialog = await screen.findByRole('dialog');
    list([row({ id: 'gmail', name: 'Gmail', health: 'ok', signedIn: signedIn(after) })]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish sign-in' }));
    // The re-read has landed once the row wears its new health.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Sign-in expired/ })).toBeNull(),
    );
  }

  it('signing in again as a different account says so: "Now b@x (was a@x)", each account isolated', async () => {
    await signInAgainAs('a@x', 'b@x');
    const note = await screen.findByText(
      (_c, el) => el?.tagName === 'P' && el.textContent === 'Now b@x (was a@x)',
    );
    expect([...note.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['b@x', 'a@x']);
  });

  it.each([
    ['the same account', 'a@x', 'a@x'],
    ['no account recorded before', null, 'b@x'],
    ['no account reported now', 'a@x', null],
  ])('says nothing extra for %s', async (_label, before, after) => {
    await signInAgainAs(before, after);
    expect(screen.queryByText(/^Now /)).toBeNull();
  });
});
