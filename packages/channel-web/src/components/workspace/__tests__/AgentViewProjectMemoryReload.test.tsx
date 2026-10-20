/**
 * W3d-2 (D2) — the late re-reads after a turn in a project chat.
 *
 * The pass that writes project memory runs after `done`, so the `done`
 * re-read usually lands before it. In a project chat `AgentView` reads the
 * thread again at about 3 s and 10 s — unless a new turn started or another
 * conversation is on screen by then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentView } from '../AgentView';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentDetail, StreamHandlers, WorkspaceAgent } from '@/lib/workspace-api';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
      interruptTurn: vi.fn(),
    },
  };
});

const agentMock = vi.mocked(workspaceApi.agent);
const sendMock = vi.mocked(workspaceApi.sendMessage);
const streamMock = vi.mocked(workspaceApi.streamReply);

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c1',
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
    ...over,
  } as unknown as AgentDetail;
}

let live: StreamHandlers | null = null;

function renderView(version = 0): ReturnType<typeof render> {
  return render(view(version));
}

function view(version: number) {
  return (
    <AgentView
      pendingReply={null}
      onPendingReplyConsumed={vi.fn()}
      agentId="a1"
      tab="chat"
      onTab={vi.fn()}
      decisions={[]}
      threadGrants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      decisionsError={null}
      version={version}
      onChanged={vi.fn()}
    />
  );
}

/** Send `text` and wait until its reply is streaming. */
async function sendAndStream(text = 'hello'): Promise<void> {
  const box = await screen.findByPlaceholderText('Message Quill');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(live).not.toBeNull());
  await act(async () => {
    live!.onText('Done — I saved the report.');
  });
}

const project = { projectId: 'p1', name: 'Launch' };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  live = null;
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  agentMock.mockResolvedValue(detail({ project } as Partial<AgentDetail>));
  sendMock.mockResolvedValue({ conversationId: 'c1', reqId: 'r1' } as never);
  streamMock.mockImplementation(async (_reqId, h) => {
    live = h;
    const signal = h.signal ?? new AbortController().signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve());
    });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Finish the turn and wait for the `done` re-read (mount read + this = 2). */
async function finishTurn(): Promise<void> {
  await act(async () => live!.onDone());
  await waitFor(() => expect(agentMock).toHaveBeenCalledTimes(2));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('late re-reads after a turn in a project chat', () => {
  it('reads again at about 3 s and 10 s, and then stops', async () => {
    renderView();
    await sendAndStream();
    await finishTurn();
    await advance(2_900);
    expect(agentMock).toHaveBeenCalledTimes(2);
    await advance(200);
    expect(agentMock).toHaveBeenCalledTimes(3);
    await advance(7_000);
    expect(agentMock).toHaveBeenCalledTimes(4);
    await advance(30_000);
    expect(agentMock).toHaveBeenCalledTimes(4);
  });

  it('does not when the chat is not in a project', async () => {
    agentMock.mockResolvedValue(detail({ project: null } as Partial<AgentDetail>));
    renderView();
    await sendAndStream();
    await finishTurn();
    await advance(15_000);
    expect(agentMock).toHaveBeenCalledTimes(2);
  });

  it('does not after another conversation is on screen', async () => {
    const { rerender } = renderView();
    await sendAndStream();
    await finishTurn();
    // Something else re-reads the agent and lands on another conversation.
    agentMock.mockResolvedValue(detail({ conversationId: 'c2', project } as Partial<AgentDetail>));
    rerender(view(1));
    await waitFor(() => expect(agentMock).toHaveBeenCalledTimes(3));
    await advance(15_000);
    expect(agentMock).toHaveBeenCalledTimes(3);
  });

  it('does not once a new message is sent', async () => {
    renderView();
    await sendAndStream();
    await finishTurn();
    live = null;
    await sendAndStream('and another thing');
    await advance(15_000);
    expect(agentMock).toHaveBeenCalledTimes(2);
  });

  it('does not after the view goes away', async () => {
    const { unmount } = renderView();
    await sendAndStream();
    await finishTurn();
    unmount();
    await advance(15_000);
    expect(agentMock).toHaveBeenCalledTimes(2);
  });
});
