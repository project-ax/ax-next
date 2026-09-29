/**
 * TASK-688 — Stop, wired: the click, the POST, the note, and the way out when
 * the stream never comes back.
 *
 * `AgentView` is driven through the real composer with `workspace-api` mocked
 * at its edge. The stream is the interesting mock: `streamReply` is handed the
 * caller's handlers and an `AbortSignal`, and — like the real one — returns
 * WITHOUT firing any callback when that signal aborts. That is the fact the
 * never-stuck fallback exists for, so the mock keeps it.
 *
 * Every test says what it would do against the code before this change.
 * Nearly all fail at the first `getByRole('button', { name: 'Stop' })`: there
 * was no such control. The ones that could pass either way say so.
 */
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentView } from '../AgentView';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentDetail, StreamHandlers, WorkspaceAgent } from '@/lib/workspace-api';
import { HttpError } from '@/lib/http';
import { rail as railFixture } from './rail-fixture';
import { STOPPED_NOTICE, STOP_COPY, STOP_FALLBACK_MS } from '../stop-copy';
import { KICKOFF_TEXT } from '@/lib/bootstrap-kickoff';

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
const interruptMock = vi.mocked(workspaceApi.interruptTurn);

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
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      decisionsError={null}
      version={0}
      onChanged={onChanged}
    />
  );
}

const stopBtn = () => screen.queryByRole('button', { name: 'Stop' });
const sendBtn = () => screen.queryByRole('button', { name: 'Send' });
const field = () => screen.getByPlaceholderText('Message Quill');
const note = () => screen.queryByRole('note');

/** Send "hello" and wait until its reply is streaming (Stop is up). */
async function startStreaming(): Promise<ReturnType<typeof render>> {
  agentMock.mockResolvedValue(detail());
  sendMock.mockResolvedValue({ conversationId: 'c1', reqId: 'r1' } as never);
  streamMock.mockImplementation(async (_reqId, h) => {
    const signal = h.signal ?? new AbortController().signal;
    live = { h, signal };
    // Never ends by itself; returns silently on abort, like the real reader.
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve());
    });
  });
  const view = renderView();
  const box = await screen.findByPlaceholderText('Message Quill');
  fireEvent.change(box, { target: { value: 'hello' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(stopBtn()).not.toBeNull());
  await act(async () => {
    live!.h.onText('Roses are');
  });
  return view;
}

/** Click Stop and let the (mocked) POST settle. */
async function clickStop(): Promise<void> {
  await act(async () => {
    fireEvent.click(stopBtn()!);
  });
}

beforeEach(() => {
  live = null;
  onChanged = vi.fn();
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  interruptMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the Stop control follows the reply', () => {
  // Passes either way on its own (no Stop existed) — the mutation that draws
  // Stop unconditionally is what makes it bite.
  it('is not on screen while idle; Send is', async () => {
    agentMock.mockResolvedValue(detail());
    renderView();
    await screen.findByPlaceholderText('Message Quill');
    expect(stopBtn()).toBeNull();
    expect(sendBtn()).not.toBeNull();
  });

  // Before: fails — Send was disabled for the whole reply and nothing else
  // was on offer.
  it('replaces Send while a reply streams, and the field goes quiet', async () => {
    await startStreaming();
    expect(stopBtn()).not.toBeNull();
    expect(sendBtn()).toBeNull();
    expect(field()).toBeDisabled();
  });
});

describe('clicking Stop', () => {
  // Before: fails at `getByRole` — no control, no `interruptTurn` call.
  it('asks the host to stop THIS conversation, with its id', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(interruptMock).toHaveBeenCalledWith('c1');
  });

  // The guard is a ref, not the disabled button: both clicks land inside one
  // React batch, before any re-render could disable anything.
  it('asks exactly once even when the button is hit twice in the same tick', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await act(async () => {
      const b = stopBtn()!;
      fireEvent.click(b);
      fireEvent.click(b);
    });
    expect(interruptMock).toHaveBeenCalledTimes(1);
  });

  it('goes quiet while the host answers, then waits for the stream rather than declaring victory', async () => {
    await startStreaming();
    let answer!: (v: { interrupted: boolean }) => void;
    interruptMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await clickStop();
    const stopping = screen.getByRole('button', { name: 'Stopping' });
    expect(stopping).toBeDisabled();
    expect(screen.getByTestId('composer-announcer').textContent).toBe('Stopping.');

    await act(async () => answer({ interrupted: true }));
    // Queued is not stopped: no note yet, the stream has not said so.
    expect(note()).toBeNull();
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled();
    expect(field()).toBeDisabled();
  });
});

describe('when the turn ends after a Stop', () => {
  // Before: fails at the Stop click. The mutation "notice without the marker"
  // is covered by the next test in this block.
  it('says the reply was stopped, gives the composer back, and drops Stop', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    await act(async () => live!.h.onDone());

    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()).toHaveTextContent(STOPPED_NOTICE);
    expect(stopBtn()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stopping' })).toBeNull();
    expect(sendBtn()).not.toBeNull();
    expect(field()).not.toBeDisabled();
    // Told twice, once each way: a visible note and a polite announcement.
    expect(screen.getByTestId('composer-announcer').textContent).toBe('Stopped.');
    // A stop is not a failure: nothing red, nothing offering a Resend.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
    // The durable thread was re-read and the shell told, as on any turn end.
    expect(onChanged).toHaveBeenCalled();
  });

  // Passes without the change too (nothing ever showed a note) — it is the
  // guard on the marker: show the note on any `done` and this goes red.
  it('says NOTHING extra when a turn simply finishes on its own', async () => {
    await startStreaming();
    await act(async () => live!.h.onDone());
    await waitFor(() => expect(sendBtn()).not.toBeNull());
    expect(note()).toBeNull();
    expect(screen.queryByText(STOPPED_NOTICE)).toBeNull();
    expect(screen.getByTestId('composer-announcer').textContent).toBe('');
  });

  // The stream's `done` can beat the POST's answer across the network. The
  // person still stopped it; the note must not depend on who wins the race.
  it('still says it when the stream’s done arrives BEFORE the host’s answer', async () => {
    await startStreaming();
    let answer!: (v: { interrupted: boolean }) => void;
    interruptMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await clickStop();
    await act(async () => live!.h.onDone());
    // Done, but we do not yet know whether that was OUR stop: say nothing.
    expect(sendBtn()).not.toBeNull();
    expect(note()).toBeNull();

    await act(async () => answer({ interrupted: true }));
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()).toHaveTextContent(STOPPED_NOTICE);
  });

  it('does not claim a stop when the host says nothing was running and the turn ended anyway', async () => {
    await startStreaming();
    let answer!: (v: { interrupted: boolean }) => void;
    interruptMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await clickStop();
    await act(async () => live!.h.onDone());
    await act(async () => answer({ interrupted: false }));
    expect(note()).toBeNull();
  });

  it('shows the failure, not the note, if the stopped turn ends in an error frame', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    await act(async () => live!.h.onError('The connection dropped.'));

    expect(note()).toBeNull();
    expect(screen.getByText(/That reply didn’t finish/)).toBeTruthy();
    expect(screen.getByText('The connection dropped.')).toBeTruthy();
    expect(sendBtn()).not.toBeNull();
  });

  it('takes the note away on the next message', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    await act(async () => live!.h.onDone());
    await waitFor(() => expect(note()).not.toBeNull());

    fireEvent.change(field(), { target: { value: 'ok, again' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(note()).toBeNull());
    expect(screen.queryByText(STOPPED_NOTICE)).toBeNull();
  });

  it('takes the note away when the person moves to another agent', async () => {
    const { rerender } = await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    await act(async () => live!.h.onDone());
    await waitFor(() => expect(note()).not.toBeNull());

    // Same mount, new agent: `AgentView` is keyed by agent in the shell, but
    // the reset must not depend on that key being there.
    const other = { ...quill, id: 'a2' };
    agentMock.mockResolvedValue(detail({ agent: other, conversationId: 'c9' }));
    rerender(<View agentId="a2" />);
    await waitFor(() => expect(agentMock).toHaveBeenCalledWith('a2'));
    expect(screen.queryByText(STOPPED_NOTICE)).toBeNull();
  });
});

describe('the note belongs to the conversation it was earned in', () => {
  // Before: fails at the Stop click. Drop the conversation check and the note
  // would sit at the foot of a different conversation's thread.
  it('is left behind when the re-read lands in a different conversation', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    // The turn ended, and by the time the thread is re-read the agent is on a
    // fresh conversation (a new chat, a compaction).
    agentMock.mockResolvedValue(detail({ conversationId: 'c-next' }));
    await act(async () => live!.h.onDone());
    await waitFor(() => expect(agentMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sendBtn()).not.toBeNull());
    expect(note()).toBeNull();
    expect(screen.queryByText(STOPPED_NOTICE)).toBeNull();
  });
});

describe('when there was nothing to stop', () => {
  // Before: fails at the Stop click.
  it('leaves the stream alone, gives Stop back, and says nothing', async () => {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: false });
    await clickStop();

    expect(live!.signal.aborted).toBe(false);
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).not.toBeDisabled();
    expect(note()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // …and when the reply then finishes by itself there is still no note.
    await act(async () => live!.h.onDone());
    await waitFor(() => expect(sendBtn()).not.toBeNull());
    expect(note()).toBeNull();
  });
});

describe('the never-stuck fallback', () => {
  async function stopAndGoQuiet(): Promise<void> {
    await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    vi.useFakeTimers();
    await clickStop();
  }

  // Before: fails at the Stop click; and had the stream just been ignored, the
  // composer would sit on "Stopping" for as long as the runner cared to take.
  it('after 8 s of silence closes the stream, hands the composer back and shows the note', async () => {
    await stopAndGoQuiet();
    expect(STOP_FALLBACK_MS).toBe(8000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STOP_FALLBACK_MS - 1);
    });
    // Not yet: still waiting on the stream's own `done`.
    expect(live!.signal.aborted).toBe(false);
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled();
    expect(note()).toBeNull();

    agentMock.mockClear();
    onChanged.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(live!.signal.aborted).toBe(true);
    expect(stopBtn()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stopping' })).toBeNull();
    expect(sendBtn()).not.toBeNull();
    expect(field()).not.toBeDisabled();
    expect(note()).toHaveTextContent(STOPPED_NOTICE);
    // The half-reply was a transient copy: the durable thread is re-read.
    expect(agentMock).toHaveBeenCalledWith('a1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('does nothing at all once the stream has ended on its own — the timer is cleared', async () => {
    await stopAndGoQuiet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => live!.h.onDone());
    expect(note()).not.toBeNull();

    agentMock.mockClear();
    onChanged.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // A late timer would abort a stream that already ended and re-read again.
    expect(agentMock).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(live!.signal.aborted).toBe(false);
  });

  it('is cancelled by an unmount: no re-read, no state written into a view nobody has', async () => {
    const { unmount } = await startStreaming();
    interruptMock.mockResolvedValue({ interrupted: true });
    vi.useFakeTimers();
    await clickStop();
    unmount();

    agentMock.mockClear();
    onChanged.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(agentMock).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('when the Stop request itself fails', () => {
  // Before: fails at the Stop click.
  it('shows the existing error strip in plain words, and lets the person try again', async () => {
    await startStreaming();
    interruptMock.mockRejectedValueOnce(new HttpError('/api/chat/x/interrupt', 500));
    await clickStop();

    expect(screen.getByText(STOP_COPY.failed)).toBeTruthy();
    // The reply is still running, so it must not be described as ended, and
    // must not offer a Resend on top of a live turn.
    expect(screen.queryByText(/didn’t finish/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(live!.signal.aborted).toBe(false);

    // Stop is back, enabled — and works.
    const again = screen.getByRole('button', { name: 'Stop' });
    expect(again).not.toBeDisabled();
    interruptMock.mockResolvedValueOnce({ interrupted: true });
    await clickStop();
    expect(interruptMock).toHaveBeenCalledTimes(2);
    // The stale complaint goes when the person tries again.
    expect(screen.queryByText(STOP_COPY.failed)).toBeNull();
  });

  it('clears the "couldn’t stop" strip when the reply then ends by itself', async () => {
    await startStreaming();
    interruptMock.mockRejectedValueOnce(new HttpError('/api/chat/x/interrupt', 500));
    await clickStop();
    expect(screen.getByText(STOP_COPY.failed)).toBeTruthy();

    await act(async () => live!.h.onDone());
    await waitFor(() => expect(sendBtn()).not.toBeNull());
    // "It may still be running" would now be false.
    expect(screen.queryByText(STOP_COPY.failed)).toBeNull();
  });

  it('on a 404 says the conversation is gone and stops waiting on a stream that cannot finish', async () => {
    await startStreaming();
    interruptMock.mockRejectedValueOnce(new HttpError('/api/chat/x/interrupt', 404));
    await clickStop();

    expect(screen.getByText(STOP_COPY.gone)).toBeTruthy();
    // Never stuck: the composer is usable again, the reader is closed.
    expect(live!.signal.aborted).toBe(true);
    expect(sendBtn()).not.toBeNull();
    expect(field()).not.toBeDisabled();
    expect(note()).toBeNull();

    // And the next message starts a fresh conversation (send-path parity).
    sendMock.mockClear();
    fireEvent.change(field(), { target: { value: 'again' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(sendMock.mock.calls[0]![0]).toMatchObject({ conversationId: null });
  });

  it('shows nothing about the failure if the reply had already ended by the time it came back', async () => {
    await startStreaming();
    let fail!: (e: unknown) => void;
    interruptMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    await clickStop();
    await act(async () => live!.h.onDone());
    await act(async () => fail(new HttpError('/api/chat/x/interrupt', 500)));
    expect(screen.queryByText(STOP_COPY.failed)).toBeNull();
    expect(note()).toBeNull();
  });
});

/*
  TASK-689 x TASK-688. The kickoff that wakes a new agent is HIDDEN (no bubble,
  and a failure of it reads "your agent's hello didn't come through"), and a Stop
  is a control on ANY streaming reply, this one included. The two were built in
  parallel and meet in `AgentView`'s failure strip and its Resend gate; a textual
  merge cannot tell you which sentence wins, so these do.

  Which test guards what (each was mutation-checked against the merge decision it
  names):
    - the FIRST test is the copy-precedence guard: against a merge that let the
      kickoff copy outrank the stop copy, a Stop that could not be sent would say
      the greeting never arrived, and it fails;
    - the THIRD is the Resend-gate guard for a hidden turn (`sent.hidden !== true`);
    - the SECOND passes against either merge order. A CONFIRMED stop sets no
      `turnError`, so the precedence never comes into it; it pins what the person
      sees when the greeting is stopped (the note, no kickoff sentence), and its
      "no empty-pane copy" holds because the stopped note fills the live thread.
*/
describe('a Stop pressed while a new agent is greeting (hidden kickoff)', () => {
  const hiddenKickoff = {
    reqId: 'r-kick',
    text: KICKOFF_TEXT,
    conversationId: 'c1',
    attachments: [],
    hidden: true,
  } as const;

  async function startGreeting(): Promise<void> {
    agentMock.mockResolvedValue(detail({ conversationId: 'c1', thread: [] }));
    streamMock.mockImplementation(async (_reqId, h) => {
      const signal = h.signal ?? new AbortController().signal;
      live = { h, signal };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', () => resolve());
      });
    });
    renderView('a1', hiddenKickoff);
    await waitFor(() => expect(stopBtn()).not.toBeNull());
    await act(async () => {
      live!.h.onText('Hey — I just came online.');
    });
  }

  it('says the STOP failed, not that the hello never came, and offers no Resend', async () => {
    await startGreeting();
    interruptMock.mockRejectedValueOnce(new HttpError('/api/chat/x/interrupt', 500));
    await clickStop();

    expect(screen.getByText(STOP_COPY.failed)).toBeTruthy();
    expect(screen.queryByText(/hello didn’t come through/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
    // The greeting is still streaming; Stop is back and works.
    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled();
  });

  it('says it was stopped once the greeting ends, without claiming the pane is empty or showing the kickoff', async () => {
    await startGreeting();
    interruptMock.mockResolvedValue({ interrupted: true });
    await clickStop();
    await act(async () => live!.h.onDone());

    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()).toHaveTextContent(STOPPED_NOTICE);
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    expect(screen.queryByText(KICKOFF_TEXT)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sendBtn()).not.toBeNull();
  });

  it('still says the HELLO failed when the greeting itself errors (no Stop involved)', async () => {
    await startGreeting();
    await act(async () => live!.h.onError('The runner went away.'));

    expect(await screen.findByText(/hello didn’t come through/)).toBeTruthy();
    expect(screen.queryByText(STOP_COPY.failed)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
  });
});
