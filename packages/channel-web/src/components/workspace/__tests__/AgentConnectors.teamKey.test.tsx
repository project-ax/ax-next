/**
 * TASK-813 — team keys, and who may sign in ON a team agent.
 *
 * Pinned:
 *   - "Team key" is on a row's `⋯` menu only when the row says `teamKey`;
 *   - the dialog saves through the REAL `workspaceApi.setTeamKey`: one PUT to
 *     the agent's team-key route with the slot and the base64 key, and never a
 *     write to the personal (`/settings/…`) or company (`/admin/…`) key routes;
 *   - only api-key slots are offered (no sign-in slot, no OAuth client secret),
 *     and the dialog closes and re-reads once every one of them is saved;
 *   - a 403 says who can add one;
 *   - Reconnect of a team's SHARED sign-in follows `sharedCredentials`, not
 *     `manageable`: a workspace admin who is not the team's admin can't sign
 *     in on it (the server would refuse), so it isn't offered and the reason
 *     says who can.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, TEAM_KEY_FORBIDDEN, type AgentDetail } from '@/lib/workspace-api';
import * as connectorsLib from '@/lib/connectors';
import type { Connector } from '@/lib/connectors';
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
      // The real client: the PUT it builds is what's under test.
      setTeamKey: actual.workspaceApi.setTeamKey,
      getTeamKeys: vi.fn(),
      removeTeamKey: vi.fn(),
    },
  };
});

vi.mock('@/lib/connectors', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/connectors');
  return { ...actual, getConnector: vi.fn() };
});

const connectorsMock = vi.mocked(workspaceApi.connectors);
const getConnectorMock = vi.mocked(connectorsLib.getConnector);
const fetchMock = vi.fn();

function fullConnector(overrides: Partial<Connector>): Connector {
  return {
    id: 'linear',
    name: 'Linear',
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'shared',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    capabilities: connectorsLib.emptyCapabilities(),
    ...overrides,
  };
}

/** One api-key slot, plus a sign-in slot and the OAuth client secret — neither a team key. */
const LINEAR = fullConnector({
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    credentials: [
      { slot: 'LINEAR_API_KEY', kind: 'api-key' },
      { slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' },
      { slot: 'LINEAR_OAUTH', kind: 'oauth', server: 'linear' },
    ],
  },
});

const TWO_KEYS = fullConnector({
  id: 'acme',
  name: 'Acme',
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    credentials: [
      { slot: 'ACME_KEY', kind: 'api-key' },
      { slot: 'ACME_SECRET', kind: 'api-key' },
    ],
  },
});

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

async function openTeamKey(name: string) {
  const menu = await openMenu(name);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Team key' }));
  return screen.findByRole('dialog');
}

function keyWrites() {
  return fetchMock.mock.calls.filter(([url]) => /\/destinations\//.test(String(url)));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(workspaceApi.rail).mockResolvedValue(rail());
  vi.mocked(workspaceApi.abilities).mockResolvedValue({
    abilities: { webSearch: true, readPages: true, runCode: true },
  });
  getConnectorMock.mockImplementation(async (id) => (id === 'acme' ? TWO_KEYS : LINEAR));
  vi.mocked(workspaceApi.getTeamKeys).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Team key (TASK-813)', () => {
  it('is on the menu only for a row that says teamKey; Add key-less rows keep their menu', async () => {
    list([row({ teamKey: true }), row({ id: 'gmail', name: 'Gmail' })]);
    renderTab();
    expect(await menuItems('Linear')).toEqual([
      'View details',
      'Team key',
      'Remove from Quill',
    ]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await menuItems('Gmail')).not.toContain('Team key');
  });

  it('saves through the team-key PUT — slot + base64 key — and never the personal or company routes', async () => {
    list([row({ teamKey: true })]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    renderTab();
    const dialog = await openTeamKey('Linear');
    expect(within(dialog).getByRole('heading', { name: 'Team key' })).toBeTruthy();
    expect(
      within(dialog).getByText(/Everyone using Quill will use this key for Linear, unless they’ve added their own\./),
    ).toBeTruthy();
    // The access disclosure sits with the key form (TASK-700).
    expect(within(dialog).getByRole('note')).toBeTruthy();
    await waitFor(() => expect(getConnectorMock).toHaveBeenCalledWith('linear', '/settings/connectors'));
    // Only the api-key slot: not the sign-in, not the OAuth client secret.
    const inputs = await within(dialog).findAllByLabelText(/^(replace )?api key$/i);
    expect(inputs).toHaveLength(1);
    expect(within(dialog).getByText('LINEAR_API_KEY')).toBeTruthy();
    expect(within(dialog).queryByText('OAUTH_CLIENT_SECRET')).toBeNull();

    fireEvent.change(inputs[0]!, { target: { value: 'lin_team_1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a-quill/connectors/linear/team-key');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      slot: 'LINEAR_API_KEY',
      payloadB64: btoa('lin_team_1'),
    });
    expect(keyWrites()).toEqual([]);
    // Closed AND re-read.
    expect(connectorsMock).toHaveBeenCalledTimes(2);
  });

  it('with two key slots, stays open until both are saved', async () => {
    list([row({ id: 'acme', name: 'Acme', teamKey: true })]);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ saved: true }), { status: 200 }));
    renderTab();
    const dialog = await openTeamKey('Acme');
    const inputs = await within(dialog).findAllByLabelText(/^(replace )?api key$/i);
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0]!, { target: { value: 'k1' } });
    fireEvent.submit(inputs[0]!.closest('form')!);
    expect(await within(dialog).findByText(/A key is saved/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(connectorsMock).toHaveBeenCalledTimes(1);

    const second = within(dialog).getAllByLabelText(/^(replace )?api key$/i)[1]!;
    fireEvent.change(second, { target: { value: 'k2' } });
    fireEvent.submit(second.closest('form')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).slot)).toEqual([
      'ACME_KEY',
      'ACME_SECRET',
    ]);
    expect(connectorsMock).toHaveBeenCalledTimes(2);
  });

  it('a 403 says who can add a team key, and the dialog stays open', async () => {
    list([row({ teamKey: true })]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    renderTab();
    const dialog = await openTeamKey('Linear');
    const input = (await within(dialog).findAllByLabelText(/^(replace )?api key$/i))[0]!;
    fireEvent.change(input, { target: { value: 'lin_team_1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(TEAM_KEY_FORBIDDEN)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(connectorsMock).toHaveBeenCalledTimes(1);
  });

  it('removing a saved team key re-reads the list and keeps the dialog open (TASK-854)', async () => {
    list([row({ teamKey: true })]);
    vi.mocked(workspaceApi.getTeamKeys).mockResolvedValue([{ slot: 'LINEAR_API_KEY', saved: true }]);
    vi.mocked(workspaceApi.removeTeamKey).mockResolvedValue(undefined);
    renderTab();
    const dialog = await openTeamKey('Linear');
    expect(await within(dialog).findByText('Key saved')).toBeTruthy();
    expect(connectorsMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('No key')).toBeTruthy();
    expect(workspaceApi.removeTeamKey).toHaveBeenCalledWith('a-quill', 'linear', 'LINEAR_API_KEY');
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Nothing went near the personal or company key routes.
    expect(keyWrites()).toEqual([]);
  });

  it('a connector that won’t load says so, with no key form', async () => {
    list([row({ teamKey: true })]);
    getConnectorMock.mockRejectedValue(new Error('get connector: 500'));
    renderTab();
    const dialog = await openTeamKey('Linear');
    expect(await within(dialog).findByText('We couldn’t open Linear just now. Please try again.')).toBeTruthy();
    expect(within(dialog).queryByLabelText(/^(replace )?api key$/i)).toBeNull();
  });
});

describe('signing in on a team agent follows sharedCredentials (TASK-813)', () => {
  const SHARED_EXPIRED = row({ id: 'gmail', name: 'Gmail', health: 'needs-reconnect', sharedSignIn: true });
  const ASK_OWNER = 'Team sign-in expired. Ask the agent’s owner to sign in again.';

  it('a workspace admin who is not the team’s admin gets no Reconnect, and is told who can', async () => {
    list([SHARED_EXPIRED], { manageable: true, sharedCredentials: false });
    renderTab();
    expect(await screen.findByRole('button', { name: ASK_OWNER })).toBeTruthy();
    const items = await menuItems('Gmail');
    expect(items).not.toContain('Reconnect');
    // Still theirs: managing the agent's connectors.
    expect(items).toContain('Remove from Quill');
  });

  it('the team’s admin keeps Reconnect', async () => {
    list([SHARED_EXPIRED], { manageable: true, sharedCredentials: true });
    renderTab();
    expect(await screen.findByRole('button', { name: 'Team sign-in expired' })).toBeTruthy();
    expect(await menuItems('Gmail')).toContain('Reconnect');
  });

  it('Retry finding the team’s sign-in expired points a non-team-admin at the owner', async () => {
    list([row({ id: 'slack', name: 'Slack', health: 'unreachable' })], {
      manageable: true,
      sharedCredentials: false,
    });
    vi.mocked(workspaceApi.retryConnector).mockResolvedValueOnce({
      health: 'needs-reconnect',
      sharedSignIn: true,
    });
    renderTab();
    const menu = await openMenu('Slack');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Retry' }));
    expect(
      await screen.findByText(
        'Slack is reachable, but its team sign-in expired. Ask the agent’s owner to sign in again.',
      ),
    ).toBeTruthy();
    expect(await menuItems('Slack')).not.toContain('Reconnect');
  });
});
