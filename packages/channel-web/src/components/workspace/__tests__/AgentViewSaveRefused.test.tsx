/**
 * TASK-720 — when a reply's files could not be saved, the person is told.
 *
 * The host refused the end-of-turn workspace save (storage full, too big, or a
 * check said no) and the runner undid that turn's file changes. Before this
 * card the reply simply finished and the files were quietly gone. Now the
 * stream's `done` carries one of three codes, and `AgentView` puts one fixed
 * sentence under the reply.
 *
 * Driven through the real composer with `workspace-api` mocked at its edge,
 * the same way `AgentViewStop.test.tsx` drives the Stop note — this notice
 * rides the same client-only lifetime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentView } from '../AgentView';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentDetail, StreamHandlers, WorkspaceAgent } from '@/lib/workspace-api';
import { rail as railFixture } from './rail-fixture';
import { SAVE_REFUSED_COPY } from '../save-refused-copy';

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

function renderView(): ReturnType<typeof render> {
  return render(
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
      version={0}
      onChanged={vi.fn()}
    />,
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

const allCopy = Object.values(SAVE_REFUSED_COPY);
const noticeShown = () => allCopy.some((s) => screen.queryByText(s) !== null);

beforeEach(() => {
  live = null;
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  agentMock.mockResolvedValue(detail());
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
  vi.restoreAllMocks();
});

describe('a reply whose files could not be saved', () => {
  it.each(['storage-full', 'too-large', 'refused'] as const)(
    'says so under the reply for %s, as an alert, and it survives the re-read',
    async (code) => {
      renderView();
      await sendAndStream();
      const readsBefore = agentMock.mock.calls.length;
      await act(async () => live!.onDone({ saveRefused: code }));

      // The done re-reads the durable thread; the notice is still there after.
      await waitFor(() => expect(agentMock.mock.calls.length).toBeGreaterThan(readsBefore));
      const line = await screen.findByText(SAVE_REFUSED_COPY[code]);
      expect(line.closest('[role="alert"]')).not.toBeNull();
      // Exactly one sentence, the right one.
      expect(allCopy.filter((s) => screen.queryByText(s) !== null)).toEqual([
        SAVE_REFUSED_COPY[code],
      ]);
    },
  );

  it('says nothing when the save went through', async () => {
    renderView();
    await sendAndStream();
    await act(async () => live!.onDone());
    await waitFor(() => expect(agentMock).toHaveBeenCalledTimes(2));
    expect(noticeShown()).toBe(false);
  });

  it('is gone the moment the person sends again', async () => {
    renderView();
    await sendAndStream();
    await act(async () => live!.onDone({ saveRefused: 'storage-full' }));
    await screen.findByText(SAVE_REFUSED_COPY['storage-full']);

    live = null;
    await sendAndStream('try again');
    expect(noticeShown()).toBe(false);
  });

  it('is only drawn in the conversation it happened in', async () => {
    renderView();
    await sendAndStream();
    // The post-done read comes back on a different conversation (a new chat).
    agentMock.mockResolvedValue(detail({ conversationId: 'c2' }));
    await act(async () => live!.onDone({ saveRefused: 'too-large' }));
    await waitFor(() => expect(agentMock).toHaveBeenCalledTimes(2));
    expect(noticeShown()).toBe(false);
  });
});
