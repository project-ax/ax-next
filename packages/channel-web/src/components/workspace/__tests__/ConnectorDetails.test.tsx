/**
 * The connector details subview (TASK-742, connectors-rail slice 9).
 *
 * Pinned, through the real rail: "Edit" (for everyone, members included)
 * swaps the whole tab for the
 * subview and back; tools sit in "Looks things up" / "Makes changes"; a
 * segment looser than the admin's ceiling is refused in the browser AND says
 * why (on hover and keyboard focus); a choice is written one tool at a time
 * and the control shows what the server re-read, never what it asked for;
 * the segmented control works from the keyboard; an inventory that could not
 * be read says so; approved access for this connector moves here with Revoke.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError, type AgentDetail } from '@/lib/workspace-api';
import type {
  AgentConnectorRow,
  AgentConnectorTool,
  AgentConnectorToolsRead,
} from '@/lib/workspace-types';
import { AgentRail } from '../AgentRail';
import { rail, siteGrant } from './rail-fixture';

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

const toolsMock = vi.mocked(workspaceApi.connectorTools);
const setMock = vi.mocked(workspaceApi.setToolVerdict);

const ROWS: AgentConnectorRow[] = [
  { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
];

const NS = 'c0123456789';
function tool(name: string, over: Partial<AgentConnectorTool> = {}): AgentConnectorTool {
  return {
    toolKey: `mcp.${NS}.${name}`,
    title: name,
    description: '',
    readOnly: null,
    outward: null,
    verdict: 'hold',
    ceiling: 'allow',
    ...over,
  };
}

function read(over: Partial<AgentConnectorToolsRead> = {}): AgentConnectorToolsRead {
  return {
    connector: { id: 'linear', name: 'Linear', access: 'personal' },
    status: 'ok',
    checkedAt: '2026-10-02T10:00:00.000Z',
    possiblyIncomplete: false,
    tools: [
      tool('Search issues', { readOnly: true, verdict: 'allow' }),
      tool('Create issue', { readOnly: false, outward: true, verdict: 'hold' }),
      // The admin set this to Ask first: Allow is out of reach.
      tool('Delete issue', { readOnly: false, verdict: 'hold', ceiling: 'hold' }),
    ],
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

function renderTab() {
  return render(
    <AgentRail detail={detail()} openPastId={null} onOpenPast={vi.fn()} tab="connectors" />,
  );
}

async function openDetails(name = 'Linear') {
  const trigger = await screen.findByRole('button', { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  const menu = await screen.findByRole('menu');
  // Slice 3 — "Edit" for everyone: a plain member's view is editable within
  // the TASK-809 ceiling too.
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
  await screen.findByRole('button', { name: 'Connectors' });
}

function rowGroup(title: string) {
  return screen.getByRole('group', { name: `What it may do with ${title}` });
}

const LINEAR_GRANT = siteGrant({
  ref: {
    grant: 'approved-capability',
    capKind: 'host',
    value: 'uploads.linear.app',
    skillId: null,
    connectorId: 'linear',
  },
  label: 'uploads.linear.app',
  source: 'approved:linear:uploads.linear.app',
  grantedFor: { kind: 'connection', id: 'linear' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceApi.rail).mockResolvedValue(rail());
  vi.mocked(workspaceApi.abilities).mockResolvedValue({
    abilities: { webSearch: true, readPages: true, runCode: true },
  });
  vi.mocked(workspaceApi.connectors).mockResolvedValue({ shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false, connectors: ROWS });
  toolsMock.mockResolvedValue(read());
});

describe('opening and closing', () => {
  it('Edit replaces the whole tab, and ‹ Connectors brings the list back', async () => {
    renderTab();
    await openDetails();
    expect(screen.getByRole('heading', { level: 3, name: 'Linear' })).toBeTruthy();
    expect(await screen.findByText('Connected · signed in as you')).toBeTruthy();
    const heading = screen.getByRole('heading', { name: /What Quill may do/ });
    expect(heading.textContent).toBe('What Quill may do3 tools');
    // The subview IS the tab: Other abilities is not drawn under it.
    expect(screen.queryByText('Other abilities')).toBeNull();
    expect(toolsMock).toHaveBeenCalledWith('a-quill', 'linear', false);

    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));
    expect(await screen.findByText('Other abilities')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /What Quill may do/ })).toBeNull();
  });

  it('says a workspace connector uses the workspace account, not "you"', async () => {
    toolsMock.mockResolvedValue(
      read({ connector: { id: 'linear', name: 'Linear', access: 'workspace' } }),
    );
    renderTab();
    await openDetails();
    expect(await screen.findByText('Connected · uses your workspace’s account')).toBeTruthy();
    expect(screen.queryByText(/signed in as you/)).toBeNull();
  });

  it('draws the legend, the routines note, and the pinned footer’s Remove', async () => {
    renderTab();
    await openDetails();
    const legend = await screen.findByRole('list', { name: 'What each choice means' });
    expect(legend.textContent).toBe('AllowAsk firstDeny');
    expect(screen.getByText('With Ask first, routines pause and wait for you.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  // A connector's own settings are a workspace admin's, in Settings ›
  // Connectors — never reachable from the rail, even for an editable row.
  it('has no Edit connector in the footer, even for an editable, removable row', async () => {
    expect(ROWS[0]).toMatchObject({ editable: true, removable: true });
    renderTab();
    await openDetails();
    const footer = await screen.findByTestId('connector-details-footer');
    expect(within(footer).getAllByRole('button').map((b) => b.textContent)).toEqual(['Remove']);
    expect(screen.queryByRole('button', { name: 'Edit connector' })).toBeNull();
  });

  it('the details menu offers no Edit — and no Retry: only Remove', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      shared: false,
      connectorsSupported: true,
      manageable: true,
      sharedCredentials: false,
      connectors: [{ ...ROWS[0]!, health: 'unreachable' }],
    });
    renderTab();
    await openDetails();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Linear' }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Remove from Quill',
    ]);
  });
});

// TASK-798 — a member on a team agent may not remove connectors or sign in
// on the agent: the details view offers neither (the list's rule, here too).
describe('a member on a team agent (TASK-798)', () => {
  function asMember(connectors: AgentConnectorRow[]) {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      shared: true,
      connectorsSupported: true,
      manageable: false, sharedCredentials: false,
      connectors,
    });
  }

  it('has no Remove — not even a disabled one — and so no footer at all, even for an editable row', async () => {
    asMember([{ ...ROWS[0]!, editable: true, removable: false }]);
    renderTab();
    await openDetails();
    await screen.findByText('Search issues');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit connector' })).toBeNull();
    expect(screen.queryByTestId('connector-details-footer')).toBeNull();
  });

  it('has no details menu at all — nothing in it is theirs', async () => {
    asMember([{ ...ROWS[0]!, health: 'needs-reconnect', removable: false }]);
    renderTab();
    await openDetails();
    await screen.findByText('Search issues');
    expect(screen.queryByRole('button', { name: 'Actions for Linear' })).toBeNull();
  });

  it('an ask-owner row says to ask the agent’s owner, with no Sign in button', async () => {
    asMember([
      { ...ROWS[0]!, health: 'needs-sign-in', setup: 'ask-owner', removable: false },
    ]);
    renderTab();
    await openDetails();
    expect(screen.getByText('Ask the agent’s owner to set it up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull();
  });

  it('the owner of the same team agent still gets Remove and Sign in', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      shared: true,
      connectorsSupported: true,
      manageable: true, sharedCredentials: true,
      connectors: [{ ...ROWS[0]!, health: 'needs-sign-in', setup: 'sign-in', removable: true }],
    });
    renderTab();
    await openDetails();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('grouping', () => {
  it('puts read-only tools under "Looks things up" and the rest under "Makes changes"', async () => {
    renderTab();
    await openDetails();
    const looks = await screen.findByRole('region', { name: 'Looks things up' });
    const makes = screen.getByRole('region', { name: 'Makes changes' });
    expect(within(looks).getByText('Search issues')).toBeTruthy();
    expect(within(looks).queryByText('Create issue')).toBeNull();
    expect(within(makes).getByText('Create issue')).toBeTruthy();
    expect(within(makes).getByText('Delete issue')).toBeTruthy();
    expect(within(makes).getByText('Others may see these')).toBeTruthy();
  });

  it('a tool that never said what it does sits under "Makes changes", without the caption', async () => {
    toolsMock.mockResolvedValue(read({ tools: [tool('Mystery')] }));
    renderTab();
    await openDetails();
    const makes = await screen.findByRole('region', { name: 'Makes changes' });
    expect(within(makes).getByText('Mystery')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Looks things up' })).toBeNull();
    expect(screen.queryByText('Others may see these')).toBeNull();
  });
});

describe('segments and the admin ceiling', () => {
  it('marks the selected segment from the server and labels each by its word', async () => {
    renderTab();
    await openDetails();
    await screen.findByText('Search issues');
    const search = rowGroup('Search issues');
    const allow = within(search).getByRole('radio', { name: 'Allow' });
    expect(allow.getAttribute('aria-checked')).toBe('true');
    expect(within(search).getByRole('radio', { name: 'Ask first' })).toBeTruthy();
    expect(within(search).getByRole('radio', { name: 'Deny' })).toBeTruthy();
  });

  it('disables a choice looser than the admin set, with the reason on focus', async () => {
    renderTab();
    await openDetails();
    await screen.findByText('Delete issue');
    const del = rowGroup('Delete issue');
    const allow = within(del).getByRole('radio', { name: 'Allow' });
    expect(allow.getAttribute('aria-disabled')).toBe('true');
    // Ask and Deny are not looser than Ask: still available.
    expect(within(del).getByRole('radio', { name: 'Deny' }).getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(allow);
    expect(setMock).not.toHaveBeenCalled();

    act(() => allow.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Your admin set this to Ask first.');
  });

  it('a member sees the agent’s owner — not "your admin" — behind an Allow the owner set (TASK-819)', async () => {
    // TASK-809's member cap on a team agent: the store holds Allow (the owner,
    // or anyone else who manages its connectors, chose it), but this member's
    // own ceiling is Ask first. No admin ceiling is involved.
    toolsMock.mockResolvedValue(
      read({ tools: [tool('Close issue', { readOnly: false, verdict: 'allow', ceiling: 'hold' })] }),
    );
    renderTab();
    await openDetails();
    await screen.findByText('Close issue');
    const row = rowGroup('Close issue');
    const allow = within(row).getByRole('radio', { name: 'Allow' });
    expect(allow.getAttribute('aria-checked')).toBe('true');
    expect(allow.getAttribute('aria-disabled')).toBe('true');
    // The member can still tighten it.
    expect(within(row).getByRole('radio', { name: 'Ask first' }).getAttribute('aria-disabled')).toBeNull();
    expect(within(row).getByRole('radio', { name: 'Deny' }).getAttribute('aria-disabled')).toBeNull();

    act(() => allow.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain(
      'The agent’s owner set this to Allow. If you change it, only they can set it back.',
    );
    expect(tip.textContent).not.toContain('admin');
  });

  it('an Ask-first tool under an Allow ceiling (no admin cap, TASK-809) can be set to Allow', async () => {
    setMock.mockResolvedValue({
      tool: { toolKey: `mcp.${NS}.Create issue`, verdict: 'allow', ceiling: 'allow' },
    });
    renderTab();
    await openDetails();
    await screen.findByText('Create issue');
    const allow = within(rowGroup('Create issue')).getByRole('radio', { name: 'Allow' });
    expect(allow.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(allow);
    expect(setMock).toHaveBeenCalledWith('a-quill', 'linear', `mcp.${NS}.Create issue`, 'allow');
  });

  it('writes one tool at a time and shows what the server re-read', async () => {
    // The server answers Ask first even though Deny was asked for: the control
    // must follow the store, not the click.
    setMock.mockResolvedValue({
      tool: { toolKey: `mcp.${NS}.Create issue`, verdict: 'deny', ceiling: 'allow' },
    });
    renderTab();
    await openDetails();
    await screen.findByText('Create issue');
    fireEvent.click(within(rowGroup('Create issue')).getByRole('radio', { name: 'Deny' }));
    expect(setMock).toHaveBeenCalledWith('a-quill', 'linear', `mcp.${NS}.Create issue`, 'deny');
    await waitFor(() =>
      expect(
        within(rowGroup('Create issue'))
          .getByRole('radio', { name: 'Deny' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('is not optimistic: a failed write leaves the old choice and says so', async () => {
    setMock.mockRejectedValue(new WorkspaceApiError('/x', 500));
    renderTab();
    await openDetails();
    await screen.findByText('Create issue');
    fireEvent.click(within(rowGroup('Create issue')).getByRole('radio', { name: 'Deny' }));
    expect(await screen.findByText(/couldn’t change that just now/)).toBeTruthy();
    expect(
      within(rowGroup('Create issue'))
        .getByRole('radio', { name: 'Ask first' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('a save the server could not read back shows the saved choice and a soft reload note, never "Nothing changed" (TASK-757)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Delete issue: the admin capped it at Ask first, so Allow is out of reach.
    setMock.mockResolvedValue({
      tool: { toolKey: `mcp.${NS}.Delete issue`, verdict: 'deny' },
      unconfirmed: true,
    });
    renderTab();
    await openDetails();
    await screen.findByText('Delete issue');
    fireEvent.click(within(rowGroup('Delete issue')).getByRole('radio', { name: 'Deny' }));
    expect(await screen.findByText(/Saved\. We couldn’t refresh this list just now, so reload to confirm\./)).toBeTruthy();
    expect(screen.queryByText(/Nothing changed/)).toBeNull();
    expect(
      within(rowGroup('Delete issue'))
        .getByRole('radio', { name: 'Deny' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // No ceiling came back: the row keeps the one it had, so Allow stays out
    // of reach rather than silently opening up.
    expect(
      within(rowGroup('Delete issue'))
        .getByRole('radio', { name: 'Allow' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[connector-tools]'));
    // The note is not an error alert.
    expect(screen.getByTestId('verdict-unconfirmed').className).not.toMatch(/destructive/);
    warn.mockRestore();
  });

  it('a 409 (the admin tightened it meanwhile) re-reads the list and says it was not saved', async () => {
    setMock.mockRejectedValue(new WorkspaceApiError('/x', 409));
    renderTab();
    await openDetails();
    await screen.findByText('Create issue');
    toolsMock.mockResolvedValue(
      read({ tools: [tool('Create issue', { verdict: 'hold', ceiling: 'hold' })] }),
    );
    fireEvent.click(within(rowGroup('Create issue')).getByRole('radio', { name: 'Allow' }));
    expect(await screen.findByText(/isn’t available for Create issue any more/)).toBeTruthy();
    await waitFor(() =>
      expect(
        within(rowGroup('Create issue'))
          .getByRole('radio', { name: 'Allow' })
          .getAttribute('aria-disabled'),
      ).toBe('true'),
    );
    expect(toolsMock).toHaveBeenCalledTimes(2);
  });

  it('works from the keyboard: arrows move between segments, Space picks one', async () => {
    setMock.mockResolvedValue({
      tool: { toolKey: `mcp.${NS}.Create issue`, verdict: 'deny', ceiling: 'allow' },
    });
    renderTab();
    await openDetails();
    await screen.findByText('Create issue');
    const group = rowGroup('Create issue');
    const ask = within(group).getByRole('radio', { name: 'Ask first' });
    const deny = within(group).getByRole('radio', { name: 'Deny' });
    // Roving focus: the segments are not three separate tab stops.
    expect(within(group).getAllByRole('radio').every((r) => r.getAttribute('tabindex') === '-1')).toBe(true);
    act(() => ask.focus());
    fireEvent.keyDown(ask, { key: 'ArrowRight' });
    // Radix moves focus on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(deny));
    // A native button activates on Space/Enter by dispatching click; jsdom
    // doesn't synthesise that, so send the keyup-driven click the browser would.
    fireEvent.keyDown(deny, { key: ' ' });
    fireEvent.keyUp(deny, { key: ' ' });
    fireEvent.click(deny);
    expect(setMock).toHaveBeenCalledWith('a-quill', 'linear', `mcp.${NS}.Create issue`, 'deny');
  });
});

describe('when the tool list cannot be read', () => {
  it('says a sign-in expired from the stored marker, not from the tool list', async () => {
    // TASK-741: only mcp-oauth's marker says a sign-in EXPIRED; a tool list
    // that answers needs-auth may be a connector nobody has signed in to.
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      shared: false,
      connectorsSupported: true, manageable: true, sharedCredentials: false,
      connectors: [{ ...ROWS[0]!, health: 'needs-reconnect' }],
    });
    toolsMock.mockResolvedValue(read({ status: 'needs-auth', tools: [] }));
    renderTab();
    await openDetails();
    expect(await screen.findByText('Sign-in expired')).toBeTruthy();
    expect(screen.queryByText(/signed in as you/)).toBeNull();
  });

  it('says a connector a session cannot fully load could not load — never "Connected" (TASK-745)', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      shared: false,
      connectorsSupported: true, manageable: true, sharedCredentials: false,
      connectors: [{ ...ROWS[0]!, health: 'not-loaded' }],
    });
    toolsMock.mockResolvedValue(read({ status: 'ok' }));
    renderTab();
    await openDetails();
    expect(await screen.findByText('Couldn’t load it')).toBeTruthy();
    expect(screen.queryByText(/Connected/)).toBeNull();
  });

  // TASK-817 — the tool read is where a provider's 401 on a stored token is
  // first seen; the check that saw it may have just written the "sign-in
  // expired" marker. So a needs-auth read under a row the list still calls
  // healthy re-reads the list once, and the row (and its Sign in again) catch up.
  it('a needs-auth tool read under a healthy row re-reads the list once; the row turns to Sign-in expired with Sign in again', async () => {
    const list = vi.mocked(workspaceApi.connectors);
    list.mockReset();
    list
      .mockResolvedValueOnce({ shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false, connectors: ROWS })
      .mockResolvedValue({
        shared: false,
        connectorsSupported: true,
        manageable: true, sharedCredentials: false,
        connectors: [{ ...ROWS[0]!, health: 'needs-reconnect' }],
      });
    toolsMock.mockResolvedValue(read({ status: 'needs-auth', tools: [] }));
    renderTab();
    await openDetails();
    expect(await screen.findByText('Sign-in expired')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
    const trigger = screen.getByRole('button', { name: 'Actions for Linear' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Sign in again' })).toBeTruthy();
  });

  it('re-reads the list at most once per tool read when the row stays healthy', async () => {
    const list = vi.mocked(workspaceApi.connectors);
    list.mockReset();
    list.mockResolvedValue({ shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false, connectors: ROWS });
    toolsMock.mockResolvedValue(read({ status: 'needs-auth', tools: [] }));
    renderTab();
    await openDetails();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // Give any further effect a chance to fire: it must not.
    await new Promise((r) => setTimeout(r, 50));
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Sign-in needed')).toBeTruthy();
  });

  it('a needs-auth tool list without the marker says sign-in is needed, never "expired"', async () => {
    toolsMock.mockResolvedValue(read({ status: 'needs-auth', tools: [] }));
    renderTab();
    await openDetails();
    expect(await screen.findByText('Sign-in needed')).toBeTruthy();
    expect(screen.queryByText(/expired/)).toBeNull();
  });

  it('says the connector could not be reached, offers Check again, and keeps saved choices', async () => {
    toolsMock.mockResolvedValue(
      read({
        status: 'unreachable',
        tools: [tool('create_issue', { verdict: 'deny' })],
      }),
    );
    renderTab();
    await openDetails();
    expect(await screen.findByText('We couldn’t reach this connector to list its tools.')).toBeTruthy();
    expect(screen.getByText('Can’t reach it')).toBeTruthy();
    expect(screen.queryByText(/signed in as you/)).toBeNull();
    // A choice the agent holds stays visible and editable.
    expect(screen.getByText('create_issue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(toolsMock).toHaveBeenLastCalledWith('a-quill', 'linear', true));
  });

  it('flags a list that may be missing tools', async () => {
    toolsMock.mockResolvedValue(read({ possiblyIncomplete: true }));
    renderTab();
    await openDetails();
    expect(await screen.findByText(/some of its tools may be\s+missing/)).toBeTruthy();
  });

  it('says it could not read the choices rather than drawing none, with Try again', async () => {
    toolsMock.mockRejectedValue(new WorkspaceApiError('/x', 500));
    renderTab();
    await openDetails();
    expect(await screen.findByText(/couldn’t read what Quill may do with Linear/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /What Quill may do/ })).toBeNull();
    toolsMock.mockResolvedValue(read());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /What Quill may do/ })).toBeTruthy();
  });
});

describe('access you approved', () => {
  it('moves a connector’s approved access into its details, with Revoke', async () => {
    vi.mocked(workspaceApi.rail).mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [LINEAR_GRANT, siteGrant()], incomplete: false } }),
    );
    renderTab();
    await screen.findByText('Linear');
    // In the list view, "Granted by you" counts only what has no other home.
    const toggle = await screen.findByRole('button', { name: /Granted by you/ });
    await waitFor(() => expect(toggle.textContent).toBe('Granted by you1'));

    await openDetails();
    const section = await screen.findByRole('region', { name: 'Access you approved' });
    expect(within(section).getByText('uploads.linear.app')).toBeTruthy();
    expect(within(section).queryByText('api.linear.app')).toBeNull();
    expect(within(section).getByRole('button', { name: /Revoke/ })).toBeTruthy();
  });

  it('says it could not read approved access when the grants read failed, instead of hiding the section (TASK-757)', async () => {
    vi.mocked(workspaceApi.rail).mockResolvedValue(
      rail({ grants: { status: 'failed', rows: [], incomplete: false } }),
    );
    renderTab();
    await openDetails();
    const section = await screen.findByRole('region', { name: 'Access you approved' });
    expect(
      within(section).getByText(/couldn.t read the access you approved for Linear just now/),
    ).toBeTruthy();
  });

  it('says the same when the whole rail read failed (TASK-757)', async () => {
    vi.mocked(workspaceApi.rail).mockRejectedValue(new WorkspaceApiError('/x', 500));
    renderTab();
    await openDetails();
    const section = await screen.findByRole('region', { name: 'Access you approved' });
    expect(within(section).getByText(/couldn.t read the access you approved/)).toBeTruthy();
  });

  it('a deployment that keeps no grants shows no section at all', async () => {
    vi.mocked(workspaceApi.rail).mockResolvedValue(
      rail({ grants: { status: 'unavailable', rows: [], incomplete: false } }),
    );
    renderTab();
    await openDetails();
    await screen.findByText('Create issue');
    expect(screen.queryByRole('region', { name: 'Access you approved' })).toBeNull();
  });

  it('keeps approved access in "Granted by you" while the list has not confirmed the connector', async () => {
    vi.mocked(workspaceApi.connectors).mockRejectedValue(new WorkspaceApiError('/x', 500));
    vi.mocked(workspaceApi.rail).mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [LINEAR_GRANT, siteGrant()], incomplete: false } }),
    );
    renderTab();
    const toggle = await screen.findByRole('button', { name: /Granted by you/ });
    await waitFor(() => expect(toggle.textContent).toBe('Granted by you2'));
  });
});

describe('pinned footer (TASK-761)', () => {
  it("sits on the rail's bottom edge, over the rows, not 20px above it with rows showing underneath", async () => {
    toolsMock.mockResolvedValue(read());
    renderTab();
    await openDetails();
    const footer = await screen.findByTestId('connector-details-footer');
    const cls = footer.className.split(/\s+/);
    // Sticky, offset by the rail scroller's bottom padding, and layered over
    // the rows' segmented controls.
    expect(cls).toEqual(expect.arrayContaining(['sticky', '-bottom-5', '-mb-5', 'z-10', 'bg-background']));
    expect(cls).not.toContain('bottom-0');
    // The offset is only right while the rail's scroller keeps `pb-5`: find
    // the real scroller this footer sticks inside and pin that pairing.
    let scroller: HTMLElement | null = footer.parentElement;
    while (scroller !== null && !scroller.className.includes('overflow-y-auto')) {
      scroller = scroller.parentElement;
    }
    expect(scroller?.className.split(/\s+/)).toContain('pb-5');
  });
});

describe("an agent whose model can't use connectors (TASK-761)", () => {
  it('says so in the details view too', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      shared: false,
      connectorsSupported: false, manageable: true, sharedCredentials: false,
      connectors: ROWS,
    });
    toolsMock.mockResolvedValue(read());
    renderTab();
    await openDetails();
    expect(
      await screen.findByText('Quill’s model can’t use connectors yet, so nothing here applies to Quill for now.'),
    ).toBeTruthy();
  });
});
