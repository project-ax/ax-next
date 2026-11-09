/**
 * The sidebar's chat list, from the shell's side.
 *
 * The chats moved out of the agent view's rail and into the sidebar, under
 * the agent switcher. Two producers feed the one list (see
 * `lib/sidebar-chats.ts`): the mounted agent view publishes its own, and off
 * the agent route (Today, Tasks) the shell reads the selected agent itself.
 * These pin the second producer and the round trips that cross routes: a chat
 * picked on Today opens on the agent's page, a new chat is created (and named)
 * by its first message, and
 * deleting the agent you are looking at takes you somewhere that still exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, type AgentDetail } from '@/lib/workspace-api';
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
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
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
const sendMock = vi.mocked(workspaceApi.sendMessage);
const streamMock = vi.mocked(workspaceApi.streamReply);
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
    // The server's newest chat, whichever one a read names.
    latest: { id: 'c-now', title: 'Earlier today', lastActivityAt: '2026-10-03T10:00:00Z' },
    memory: { rules: { status: 'unavailable', doc: null } },
    ...over,
  } as AgentDetail;
}

/**
 * The agent read, by the conversation it names: the live one, a past one, or
 * the chat a first message just created (the server's newest, named after
 * that message).
 */
function agentReads() {
  agentMock.mockImplementation(async (_id: string, conversationId?: string) => {
    if (conversationId === 'c-march')
      return detail('c-march', { thread: [{ kind: 'user', id: 'm1', text: 'the march thread' }] });
    if (conversationId === 'c-new' || (conversationId === undefined && sendMock.mock.calls.length > 0))
      return detail('c-new', {
        thread: [{ kind: 'user', id: 'x1', text: 'Plan the offsite' }],
        latest: { id: 'c-new', title: 'Plan the offsite', lastActivityAt: '2026-10-04T10:00:00Z' },
        past: [{ id: 'c-now', title: 'Earlier today', lastActivityAt: '2026-10-03T10:00:00Z' }],
      });
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
  sendMock.mockReset();
  streamMock.mockReset();
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

  it('New chat opens an empty chat on the agent’s page and creates nothing yet', async () => {
    renderAt('/workspace');
    await screen.findByRole('button', { name: 'March planning' });
    const rows = within(chats()).getAllByRole('button', { name: /^(?!Options)/ }).length;

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill'));
    expect(await screen.findByPlaceholderText('Message Quill')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('the live thread')).toBeNull());
    // No empty chat in the list, and none marked open: it exists on its first message.
    expect(within(chats()).getAllByRole('button', { name: /^(?!Options)/ })).toHaveLength(rows);
    expect(within(chats()).queryByRole('button', { current: 'page' })).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('the first message creates the chat, which appears named after it while the reply runs', async () => {
    sendMock.mockResolvedValue({ conversationId: 'c-new', reqId: 'r1' });
    // The reply never finishes in this test: the row must not wait for it.
    streamMock.mockImplementation(() => new Promise(() => {}));
    renderAt('/workspace/agents/a-quill');
    await screen.findByText('the live thread');

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(screen.queryByText('the live thread')).toBeNull());
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'Plan the offsite' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: null })),
    );
    expect(
      await within(chats()).findByRole('button', { name: 'Plan the offsite', current: 'page' }),
    ).toBeTruthy();
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
