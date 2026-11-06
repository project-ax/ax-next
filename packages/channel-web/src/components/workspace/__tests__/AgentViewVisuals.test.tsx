/**
 * Chat visuals in the live thread (Task 12): a `show_visual` result arrives on
 * the stream, is drawn at once, survives the gap between `done` and the
 * re-read, and is then drawn exactly ONCE — from the durable thread — rather
 * than twice (live + reloaded) or not at all (cleared before the read landed).
 *
 * Harness as in `AgentViewStop.test.tsx`. `VisualFrame` is mocked: its real
 * body is a sandboxed iframe with ~355 KB of vendored assets, and what is
 * under test here is only whether, where and under which conversation one is
 * drawn.
 */
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentView } from '../AgentView';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentDetail, StreamHandlers, ThreadVisual, WorkspaceAgent } from '@/lib/workspace-api';
import { rail as railFixture } from './rail-fixture';

vi.mock('../visual/VisualFrame', () => ({
  default: ({ visual, conversationId }: { visual: ThreadVisual; conversationId: string }) => (
    <div data-testid="visual" data-conv={conversationId}>{visual.title}</div>
  ),
}));

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      // The side panel always mounts Files; a root 404 is an empty list.
      userFiles: vi.fn(async () => {
        const E = actual.WorkspaceApiError as new (path: string, status: number) => Error;
        throw new E('/agents/a-quill/user-files/', 404);
      }),
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

/** The last stream the mock handed out: its handlers and its signal. */
let live: { h: StreamHandlers; signal: AbortSignal } | null = null;
let onChanged = vi.fn();

function renderView(
  agentId = 'a1',
  pendingReply?: ComponentProps<typeof AgentView>['pendingReply'],
): ReturnType<typeof render> {
  return render(<View agentId={agentId} pendingReply={pendingReply ?? null} />);
}

function View({
  agentId,
  pendingReply = null,
}: {
  agentId: string;
  pendingReply?: ComponentProps<typeof AgentView>['pendingReply'];
}) {
  return (
    <AgentView
      pendingReply={pendingReply}
      onPendingReplyConsumed={vi.fn()}
      agentId={agentId}
      tab="chat"
      onTab={vi.fn()}
      decisions={[]}
      threadGrants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      onBack={vi.fn()}
      decisionsError={null}
      version={0}
      onChanged={onChanged}
    />
  );
}


const chart: ThreadVisual = { artifactId: 'art-1', title: 'Sales by month', summary: 'A bar chart.' };

/** Send "hello" from a view whose first read is `first`; the stream stays open. */
async function sendHello(
  first: AgentDetail,
  conversationId = 'c1',
): Promise<ReturnType<typeof render>> {
  agentMock.mockResolvedValue(first);
  sendMock.mockResolvedValue({ conversationId, reqId: 'r1' } as never);
  streamMock.mockImplementation(async (_reqId, h) => {
    const signal = h.signal ?? new AbortController().signal;
    live = { h, signal };
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve());
    });
  });
  const view = renderView();
  const box = await screen.findByPlaceholderText('Message Quill');
  fireEvent.change(box, { target: { value: 'hello' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(live).not.toBeNull());
  return view;
}

async function showChart(): Promise<void> {
  await act(async () => {
    live!.h.onToolUse?.({ toolCallId: 'v1', toolName: 'show_visual' });
    live!.h.onToolResult?.({ toolCallId: 'v1' });
    live!.h.onVisual?.(chart);
  });
}

beforeEach(() => {
  live = null;
  onChanged = vi.fn();
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a visual shown during a live turn', () => {
  it('(RF4) shows a live visual, keeps it through the re-read, then shows it exactly once', async () => {
    await sendHello(detail());
    await showChart();
    expect(await screen.findAllByTestId('visual')).toHaveLength(1);
    expect(screen.getByTestId('visual')).toHaveAttribute('data-conv', 'c1');

    // `done`, with the re-read held open: the live copy must not vanish yet.
    let land!: (d: AgentDetail) => void;
    agentMock.mockReturnValueOnce(new Promise<AgentDetail>((r) => { land = r; }));
    await act(async () => live!.h.onDone());
    await waitFor(() => expect(agentMock).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId('visual')).toHaveLength(1);

    // The re-read returns the committed turn carrying the same visual.
    await act(async () =>
      land(
        detail({
          thread: [
            { kind: 'user', id: 't1', text: 'hello' },
            { kind: 'agent', id: 't2', text: '', at: '2026-11-05T10:00:00Z', visuals: [chart] },
          ],
        } as Partial<AgentDetail>),
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId('visual')).toHaveLength(1));
    expect(screen.getByTestId('visual')).toHaveAttribute('data-conv', 'c1');
  });

  it('draws a second, different visual alongside the durable one, and the same one only once', async () => {
    await sendHello(
      detail({
        thread: [{ kind: 'agent', id: 't0', text: '', at: '2026-11-05T09:00:00Z', visuals: [chart] }],
      } as Partial<AgentDetail>),
    );
    await screen.findAllByTestId('visual');
    await act(async () => {
      live!.h.onVisual?.(chart); // already durable: not drawn twice
      live!.h.onVisual?.({ ...chart, artifactId: 'art-2', title: 'Second' });
      live!.h.onVisual?.({ ...chart, artifactId: 'art-2', title: 'Second' }); // deduped
    });
    const titles = screen.getAllByTestId('visual').map((n) => n.textContent);
    expect(titles).toEqual(['Sales by month', 'Second']);
  });

  it("(VISUALS-1) gives a new chat's live visual the stream's conversation id", async () => {
    await sendHello(detail({ conversationId: null }), 'c-new');
    await showChart();
    const frame = await screen.findByTestId('visual');
    expect(frame).toHaveAttribute('data-conv', 'c-new');
  });

  it('drops live visuals when the person moves to another agent', async () => {
    const { rerender } = await sendHello(detail());
    await showChart();
    await screen.findByTestId('visual');
    // Same mount, new agent (the shell keys the view, but the reset must not
    // depend on that key).
    agentMock.mockResolvedValue(detail({ agent: { ...quill, id: 'a2' }, conversationId: 'c1' }));
    rerender(<View agentId="a2" />);
    await waitFor(() => expect(agentMock).toHaveBeenCalledWith('a2'));
    expect(screen.queryByTestId('visual')).toBeNull();
  });
});
