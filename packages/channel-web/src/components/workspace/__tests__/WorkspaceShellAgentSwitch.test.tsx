/**
 * TASK-393 — switching agents mid-send must not stream the old agent's reply
 * into the new agent's pane.
 *
 * `AgentView` used to be rendered with no `key` in `WorkspaceShell`, so a
 * route change just swapped its `agentId` prop and reused the SAME instance.
 * `send()`'s POST (`workspaceApi.sendMessage`) carries no abort signal, so a
 * switch mid-send let agent A's `.then` continuation keep running against
 * whatever agent the pane now shows: it overwrote `conversationRef` with A's
 * conversation id and streamed A's reply into B's pane.
 *
 * This test starts a send for agent A, switches to agent B before the POST
 * resolves, then lets A's send (and its mocked SSE reply) land — and asserts
 * none of it painted onto agent B's pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { workspaceApi, type StreamHandlers } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { resetDraftsForTest } from '@/lib/workspace-draft-store';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const sendMock = vi.mocked(workspaceApi.sendMessage);
const streamMock = vi.mocked(workspaceApi.streamReply);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

const AGENTS = [
  {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting' as const,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
  {
    id: 'a-tern',
    name: 'Tern',
    state: 'resting' as const,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
];

function detailFor(id: string) {
  return {
    agent: AGENTS.find((a) => a.id === id)!,
    conversationId: `c-${id}`,
    thread: [],
    decisions: { status: 'ok' as const },
    past: [],
    memory: {
      rules: { status: 'unavailable' as const, doc: null },
      learned: { status: 'unavailable' as const, docs: [] },
    },
  };
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: AGENTS });
  agentMock.mockReset();
  agentMock.mockImplementation(async (id: string) => detailFor(id));
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  sendMock.mockReset();
  streamMock.mockReset();
  resetDraftsForTest();
});

afterEach(() => {
  resetDraftsForTest();
});

describe('switching agents mid-send', () => {
  it("never streams agent A's reply into agent B's pane", async () => {
    renderAt('/workspace/agents/a-quill');

    // A's own conversation pane, so we know the right agent is up first.
    await screen.findByLabelText('Conversation with Quill');

    // Hold A's `sendMessage` POST open until we say so — the exact window
    // the bug lived in.
    let releaseSend: (() => void) | undefined;
    sendMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSend = () =>
            resolve({ conversationId: 'c-a-quill', reqId: 'r-stale' });
        }),
    );

    fireEvent.change(screen.getByPlaceholderText('Message Quill'), {
      target: { value: 'hello from quill thread' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The POST is in flight (unresolved). Switch to agent B before it lands.
    fireEvent.click(screen.getByRole('button', { name: 'Tern' }));
    await screen.findByLabelText('Conversation with Tern');

    // Now let A's send resolve, and have the mocked SSE reader push a text
    // chunk and then hang (never call `onDone`) — the window in which a
    // reader who never finishes would otherwise sit rendered on screen.
    let onTextOfStaleStream: ((chunk: string) => void) | undefined;
    streamMock.mockImplementationOnce(
      (_reqId: string, handlers: StreamHandlers) =>
        new Promise<void>(() => {
          onTextOfStaleStream = handlers.onText;
        }),
    );
    await act(async () => {
      releaseSend?.();
      // Flush the microtask queue the `.then` continuation runs on, far
      // enough that `streamFrom` has called `workspaceApi.streamReply` and
      // captured its handlers above.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(streamMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      onTextOfStaleStream?.('STALE REPLY FROM QUILL');
    });

    // B's pane must still be what is on screen, and none of A's stale reply
    // may have painted into it.
    await screen.findByLabelText('Conversation with Tern');
    expect(screen.queryByText('STALE REPLY FROM QUILL')).toBeNull();
    expect(screen.getByPlaceholderText('Message Tern')).toBeTruthy();
  });

  it('keeps an unsent draft when you switch away and back (the remount cost)', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByLabelText('Conversation with Quill');

    fireEvent.change(screen.getByPlaceholderText('Message Quill'), {
      target: { value: 'a note I have not sent yet' },
    });

    // Switch away — this REMOUNTS the pane (TASK-393's `key={route.id}`).
    fireEvent.click(screen.getByRole('button', { name: 'Tern' }));
    await screen.findByLabelText('Conversation with Tern');
    expect(screen.getByPlaceholderText('Message Tern')).toHaveValue('');

    // Switch back — the draft must still be there.
    fireEvent.click(screen.getByRole('button', { name: 'Quill' }));
    await screen.findByLabelText('Conversation with Quill');
    expect(screen.getByPlaceholderText('Message Quill')).toHaveValue(
      'a note I have not sent yet',
    );
  });
});
