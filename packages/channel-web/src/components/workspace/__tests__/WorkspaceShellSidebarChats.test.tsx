/**
 * The sidebar's chat list, from the shell's side.
 *
 * The chats moved out of the agent view's rail and into the sidebar, under
 * the agent switcher. Two producers feed the one list (see
 * `lib/sidebar-chats.ts`): the mounted agent view publishes its own, and off
 * the agent route (Today, Tasks) the shell reads the selected agent itself.
 * These pin the second producer and the round trips that cross routes: a chat
 * picked on Today opens on the agent's page, a new chat lands on screen, and
 * deleting the agent you are looking at takes you somewhere that still exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, type AgentDetail } from '@/lib/workspace-api';
import { conversationControls } from '@/lib/conversation-controls';
import { deleteAgent } from '@/lib/admin';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';
import { openAgentOptions } from './sidebar-helpers';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      decisions: vi.fn(async () => ({ decisions: [] })),
      conversationDecisions: vi.fn(async () => ({ decisions: [] })),
      tasks: vi.fn(async () => ({ tasks: [], unavailableAgents: [] })),
      grants: vi.fn(async () => ({ grants: [] })),
      selfChanges: vi.fn(async () => ({ changes: [] })),
      rail: vi.fn(async () => railFixture()),
      memoryEvents: vi.fn(() => new Promise(() => {})),
      connectors: vi.fn(async () => ({
        connectors: [],
        shared: false,
        manageable: true,
        sharedCredentials: false,
        connectorsSupported: true,
      })),
    },
  };
});

vi.mock('@/lib/conversation-controls', () => ({
  conversationControls: {
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    export: vi.fn(),
  },
}));

vi.mock('@/lib/admin', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/admin');
  return { ...actual, deleteAgent: vi.fn() };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const createMock = vi.mocked(conversationControls.create);
const deleteAgentMock = vi.mocked(deleteAgent);

const QUILL = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};
const TERN = { ...QUILL, id: 'a-tern', name: 'Tern' };

function detail(conversationId: string, over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: QUILL,
    conversationId,
    thread: [],
    decisions: { status: 'ok' },
    past: [
      { id: 'c-march', title: 'March planning', lastActivityAt: '2026-10-01T10:00:00Z' },
      { id: 'c-april', title: 'April invoices', lastActivityAt: '2026-10-02T10:00:00Z' },
    ],
    memory: { rules: { status: 'unavailable', doc: null } },
    ...over,
  } as AgentDetail;
}

/**
 * The agent read, by the conversation it names: the live one, a past
 * excerpt, or the chat New chat just created.
 */
function agentReads() {
  agentMock.mockImplementation(async (_id: string, conversationId?: string) => {
    if (conversationId === 'c-march')
      return detail('c-march', { thread: [{ kind: 'user', id: 'm1', text: 'the march thread' }] });
    /*
      Once a chat has been created it IS the agent's current one — the server
      contract the view's plain re-read relies on (it names no conversation).
    */
    if (conversationId === 'c-new' || (conversationId === undefined && createMock.mock.calls.length > 0))
      return detail('c-new', { thread: [], past: [{ id: 'c-now', title: 'Earlier today', lastActivityAt: '2026-10-03T10:00:00Z' }] });
    return detail('c-now', { thread: [{ kind: 'user', id: 'n1', text: 'the live thread' }] });
  });
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' }}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

/** The sidebar's Chats section. */
function chats(): HTMLElement {
  return screen.getByRole('region', { name: 'Chats' });
}

beforeEach(() => {
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [QUILL, TERN] });
  agentMock.mockReset();
  agentReads();
  createMock.mockReset();
  deleteAgentMock.mockReset();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the sidebar chat list off the agent route', () => {
  it('on Today, lists the first agent’s chats from the shell’s own read', async () => {
    renderAt('/workspace');

    expect(await screen.findByRole('button', { name: 'March planning' })).toBeTruthy();
    expect(within(chats()).getByRole('button', { name: 'April invoices' })).toBeTruthy();
    // Read once, for the agent the switcher shows — not for every agent.
    expect(agentMock).toHaveBeenCalledWith('a-quill');
    expect(agentMock).not.toHaveBeenCalledWith('a-tern');
    // Off the agent's own page nothing is "open", so no row claims to be.
    expect(within(chats()).queryByRole('button', { current: 'page' })).toBeNull();
  });

  it('picking a chat on Today opens the agent’s page on that conversation', async () => {
    renderAt('/workspace');

    fireEvent.click(await screen.findByRole('button', { name: 'March planning' }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill'));
    expect(await screen.findByText('the march thread')).toBeTruthy();
    expect(agentMock).toHaveBeenCalledWith('a-quill', 'c-march');
    expect(
      within(chats()).getByRole('button', { name: 'March planning', current: 'page' }),
    ).toBeTruthy();
  });

  it('New chat creates the conversation and lands on it', async () => {
    createMock.mockResolvedValue({ conversationId: 'c-new' });
    renderAt('/workspace');
    await screen.findByRole('button', { name: 'March planning' });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith('a-quill'));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill'));
    await waitFor(() => expect(agentMock).toHaveBeenCalledWith('a-quill', 'c-new'));
    // The new chat's list is the one on screen: the old live one is now past.
    expect(await within(chats()).findByRole('button', { name: 'Earlier today' })).toBeTruthy();
    expect(screen.queryByText('the live thread')).toBeNull();
  });

  it('says so where the button was when New chat fails, and stays put', async () => {
    createMock.mockRejectedValue(new Error('create → 500'));
    renderAt('/workspace');
    await screen.findByRole('button', { name: 'March planning' });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    expect(await within(chats()).findByText(/couldn’t finish that just now/)).toBeTruthy();
    expect(window.location.pathname).toBe('/workspace');
  });
});

describe('deleting the agent from its ⋮ menu', () => {
  it('deleting the agent on screen returns to Today', async () => {
    deleteAgentMock.mockResolvedValue(undefined);
    renderAt('/workspace/agents/a-quill');
    await screen.findByText('the live thread');

    const menu = await openAgentOptions('Quill');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete agent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete agent?' });
    // The board read after the delete no longer has it.
    boardMock.mockResolvedValue({ agents: [TERN] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    await waitFor(() => expect(deleteAgentMock).toHaveBeenCalledWith('a-quill'));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    // The switcher moves to an agent that still exists.
    expect(await screen.findByRole('button', { name: /^Tern, .*Switch agent/ })).toBeTruthy();
  });

  it('a refused delete says nothing was removed and keeps the agent', async () => {
    deleteAgentMock.mockRejectedValue(new Error('delete agent: 403'));
    renderAt('/workspace/agents/a-quill');
    await screen.findByText('the live thread');

    const menu = await openAgentOptions('Quill');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete agent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete agent?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    expect(await within(dialog).findByText(/nothing was removed/)).toBeTruthy();
    expect(window.location.pathname).toBe('/workspace/agents/a-quill');
  });
});
