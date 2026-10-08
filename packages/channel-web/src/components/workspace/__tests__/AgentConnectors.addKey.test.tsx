/**
 * Slice 3 — Add key: a row whose per-agent key is missing (`setup:'add-key'`)
 * offers **Add key** to whoever may choose the agent's account — a team
 * agent's team admin, AND a personal agent's owner.
 *
 * Pinned:
 *   - the dialog saves through the REAL `workspaceApi.setAgentKey`: one PUT
 *     per key slot to the agent's `…/key` route with the slot and the base64
 *     key, and never a write to the personal (`/settings/…`) or company
 *     (`/admin/…`) key routes;
 *   - only api-key slots are offered (no sign-in slot, no OAuth client
 *     secret) — so an OAuth connector that also declares a header key gets
 *     its header key here, after its sign-in;
 *   - Save stays disabled until every slot has a key; the dialog closes and
 *     re-reads once they are saved;
 *   - a 403 says who can add one, and the dialog stays open with the key typed;
 *   - a connector that won't load says so.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, AGENT_KEY_FORBIDDEN, type AgentDetail } from '@/lib/workspace-api';
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
      connectorTools: vi.fn(),
      setToolVerdict: vi.fn(),
      // The real client: the PUT it builds is what's under test.
      setAgentKey: actual.workspaceApi.setAgentKey,
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
    health: 'needs-sign-in',
    setup: 'add-key',
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
    shared: false,
    connectorsSupported: true,
    manageable: true,
    sharedCredentials: false,
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

async function openAddKey(name: string) {
  const menu = await openMenu(name);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add key' }));
  return screen.findByRole('dialog');
}

function keyWrites() {
  return fetchMock.mock.calls.filter(([url]) => /\/destinations\//.test(String(url)));
}

function puts() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit).method,
    body: JSON.parse((init as RequestInit).body as string) as unknown,
  }));
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Add key (slice 3)', () => {
  it('on a PERSONAL agent, saves through the agent key PUT — slot + base64 key — and nothing else', async () => {
    list([row({})]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    renderTab();
    const dialog = await openAddKey('Linear');
    expect(within(dialog).getByRole('heading', { name: 'Add a key for Linear' })).toBeTruthy();
    expect(within(dialog).getByText('Quill will use this key for Linear.')).toBeTruthy();
    // The access disclosure sits with the key form (TASK-700).
    expect(within(dialog).getByTestId('connector-access-notice')).toBeTruthy();
    await waitFor(() => expect(getConnectorMock).toHaveBeenCalledWith('linear', '/settings/connectors'));
    // Only the api-key slot: not the sign-in, not the OAuth client secret.
    const inputs = (await within(dialog).findAllByLabelText(/key/i, { selector: 'input' }));
    expect(inputs).toHaveLength(1);
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(inputs[0]!, { target: { value: 'lin_agent_1' } });
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts()).toEqual([
      {
        url: '/api/workspace/agents/a-quill/connectors/linear/key',
        method: 'PUT',
        body: { slot: 'LINEAR_API_KEY', payloadB64: btoa('lin_agent_1') },
      },
    ]);
    expect(keyWrites()).toEqual([]);
    // Closed AND re-read.
    expect(connectorsMock).toHaveBeenCalledTimes(2);
  });

  // A pasted key often carries a trailing newline or spaces; they are never
  // part of a key, and a key with them fails at the provider.
  it('trims spaces and newlines around a pasted key before encoding it', async () => {
    list([row({})]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    renderTab();
    const dialog = await openAddKey('Linear');
    const inputs = await within(dialog).findAllByLabelText(/key/i, { selector: 'input' });
    fireEvent.change(inputs[0]!, { target: { value: '  lin_agent_1\r\n' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts()).toEqual([
      {
        url: '/api/workspace/agents/a-quill/connectors/linear/key',
        method: 'PUT',
        body: { slot: 'LINEAR_API_KEY', payloadB64: btoa('lin_agent_1') },
      },
    ]);
  });

  it('on a team agent, its team admin is told everyone will use the key', async () => {
    list([row({})], { shared: true, sharedCredentials: true });
    renderTab();
    const dialog = await openAddKey('Linear');
    expect(within(dialog).getByText('Everyone using Quill will use this key for Linear.')).toBeTruthy();
  });

  it('with two key slots, saves both — Save waits for every key', async () => {
    list([row({ id: 'acme', name: 'Acme' })]);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ saved: true }), { status: 200 }));
    renderTab();
    const dialog = await openAddKey('Acme');
    const inputs = await within(dialog).findAllByLabelText(/key|secret/i, { selector: 'input' });
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0]!, { target: { value: 'k1' } });
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(inputs[1]!, { target: { value: 'k2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts().map((p) => (p.body as { slot: string }).slot)).toEqual(['ACME_KEY', 'ACME_SECRET']);
    expect(connectorsMock).toHaveBeenCalledTimes(2);
  });

  it('a 403 says who can add one; the dialog stays open with the key typed', async () => {
    list([row({})]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    renderTab();
    const dialog = await openAddKey('Linear');
    const input = (await within(dialog).findAllByLabelText(/key/i, { selector: 'input' }))[0]!;
    fireEvent.change(input, { target: { value: 'lin_agent_1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(AGENT_KEY_FORBIDDEN)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('lin_agent_1');
    expect(connectorsMock).toHaveBeenCalledTimes(1);
  });

  it('a connector that won’t load says so, with no key form', async () => {
    list([row({})]);
    getConnectorMock.mockRejectedValue(new Error('get connector: 500'));
    renderTab();
    const dialog = await openAddKey('Linear');
    expect(await within(dialog).findByText('We couldn’t open Linear just now. Please try again.')).toBeTruthy();
    expect(within(dialog).queryByLabelText(/key/i, { selector: 'input' })).toBeNull();
  });
});
