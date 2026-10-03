/**
 * The connector details subview (TASK-742, connectors-rail slice 9).
 *
 * Pinned, through the real rail: "View details" swaps the whole tab for the
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
  { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok' },
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
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'View details' }));
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
  vi.mocked(workspaceApi.connectors).mockResolvedValue({ shared: false, connectors: ROWS });
  toolsMock.mockResolvedValue(read());
});

describe('opening and closing', () => {
  it('View details replaces the whole tab, and ‹ Connectors brings the list back', async () => {
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

  it('draws the legend, the routines note, and the pinned footer actions', async () => {
    renderTab();
    await openDetails();
    const legend = await screen.findByRole('list', { name: 'What each choice means' });
    expect(legend.textContent).toBe('AllowAsk firstDeny');
    expect(screen.getByText('With Ask first, routines pause and wait for you.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit connector' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
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
      connectors: [{ ...ROWS[0]!, health: 'not-loaded' }],
    });
    toolsMock.mockResolvedValue(read({ status: 'ok' }));
    renderTab();
    await openDetails();
    expect(await screen.findByText('Couldn’t load it')).toBeTruthy();
    expect(screen.queryByText(/Connected/)).toBeNull();
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
