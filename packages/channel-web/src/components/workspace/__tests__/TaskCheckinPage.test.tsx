/**
 * A check-in's own page (TASK-911, See what it did): when it ran, why and how
 * it ended, then what the agent said and every tool it ran, read-only.
 *
 * Driven through the REAL `useTaskCheckin` and `AgentConversation`, with only
 * the network mocked, so each case is what the reader would actually see. The
 * copy is asserted verbatim because it is decided (TASK-911 plan, Task 8), and
 * its apostrophe is U+2019, not the ASCII one.
 *
 * NOTHING ON THIS PAGE MAY SEND INTO, STOP, RETRY OR CONTINUE THE CHECK-IN.
 * `offers no way to send…` pins that against the one row that could offer it,
 * an open approval with a draft to edit, while watching every request the page
 * could make. Its approval buttons are the queue's own, and
 * `answers an approval…` pins that they reach the queue's handlers.
 *
 * Times are built in the reader's own calendar (`new Date(y, m, d, …)`) and the
 * expected words from `localTime`, so nothing depends on where or when the
 * suite runs.
 */
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BRIEF_DIDNT_LOAD } from '../../../../../routines/src/brief.js';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { workspaceApi, WorkspaceApiError, type ThreadMessage } from '@/lib/workspace-api';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { localTime } from '@/lib/workspace-time';
import type { TaskCheckin, TaskUpdate } from '@/lib/workspace-types';
import { saveBlob } from '@/lib/file-download';
import { DECISION_SESSION_EXPIRED, DECISION_THREAD_READ_FAILED } from '../decision-copy';
import { TaskCheckinPage } from '../TaskCheckinPage';
import { decisionFixture, resolvedFixture } from './decision-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { taskCheckin: vi.fn() } };
});

// A download's last step clicks a link, which jsdom can't follow.
vi.mock('@/lib/file-download', () => ({ saveBlob: vi.fn() }));

const checkinMock = vi.mocked(workspaceApi.taskCheckin);

const NOW = new Date(2026, 9, 22, 12, 0);
const FIRED = new Date(2026, 9, 22, 10, 2).toISOString();
const CHECKIN_PATH = '/tasks/a1/t1/checkins/c1';
const TASK_NAME = 'Zero open support tickets';
const UPDATE = '3 open. I’m answering #4411 and #4412 now.';
const REFRESH_FAILED =
  'We couldn’t refresh this check-in just now, so what you see may be out of date.';

/** The check-in as its Updates entry shows it: it finished, and it reported. */
function checkIn(over: Partial<TaskUpdate> = {}): TaskUpdate {
  return {
    firedAt: FIRED,
    status: 'ok',
    error: null,
    report: { status: 'needs-you', update: UPDATE },
    conversationId: 'c1',
    ...over,
  };
}

/** One thing Caveman said during it. */
const SAID: ThreadMessage = { kind: 'agent', id: 'turn-2', text: 'Checking the queue.', at: FIRED };

function page(over: Partial<TaskCheckin> = {}): TaskCheckin {
  return {
    taskName: TASK_NAME,
    agentName: 'Caveman',
    checkIn: checkIn(),
    triggerSource: 'tick',
    thread: [SAID],
    decisions: { status: 'ok' },
    ...over,
  };
}

/**
 * An approval the check-in is still waiting on. It carries a draft, so the
 * card would offer "Edit first" (which sends a new message) if editing were on.
 */
const OPEN = decisionFixture({
  id: 'd1',
  agentId: 'a1',
  primaryLabel: 'Allow',
  preview: { meta: '', body: 'Original draft' },
});
const OPEN_ROW: ThreadMessage = { kind: 'approval', id: 'decision-d1', decisionId: 'd1' };

type Props = ComponentProps<typeof TaskCheckinPage>;

function renderPage(over: Partial<Props> = {}) {
  const onNavigate = vi.fn<(route: WorkspaceRoute) => void>();
  const onApprove = vi.fn<(id: string, scope?: 'once' | 'agent-routines') => void>();
  const onDismiss = vi.fn<(id: string) => void>();
  const onUndo = vi.fn<(id: string) => void>();
  const onRetryDecisions = vi.fn<() => void>();
  const props: Props = {
    agentId: 'a1',
    routineId: 't1',
    conversationId: 'c1',
    leading: <button type="button">Open navigation</button>,
    onNavigate,
    decisions: [],
    onApprove,
    onDismiss,
    onUndo,
    decisionsError: null,
    onRetryDecisions,
    ...over,
  };
  const view = render(<TaskCheckinPage {...props} />);
  return { ...view, props, onNavigate, onApprove, onDismiss, onUndo, onRetryDecisions };
}

function summary(): HTMLElement {
  return screen.getByRole('region', { name: 'How this check-in went' });
}

/** Wait for the check-in to be on screen, and hand back its summary. */
async function ready(): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1, name: `Check-in at ${localTime(FIRED)}` });
  return summary();
}

/** The transcript: `AgentConversation`'s own region, under its own name. */
function transcript(): HTMLElement {
  return screen.getByRole('region', { name: 'Conversation with Caveman' });
}

let warn: MockInstance;

beforeEach(() => {
  checkinMock.mockReset();
  vi.mocked(saveBlob).mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // Failed reads are logged, and several cases fail on purpose.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('TaskCheckinPage (TASK-911)', () => {
  it('says when it ran, why, and how it ended', async () => {
    checkinMock.mockResolvedValue(page());
    renderPage();
    const s = await ready();
    expect(
      within(s).getByRole('heading', { level: 2, name: 'How this check-in went' }),
    ).toHaveClass('sr-only');
    expect(within(s).getByText('Needs you')).toBeInTheDocument();
    expect(within(s).getByText(UPDATE)).toBeInTheDocument();
    expect(within(s).getByText('Caveman · On its schedule · read-only')).toBeInTheDocument();
    // It finished, so there is no reason line.
    expect(within(s).queryByText('No reason was recorded.')).toBeNull();
    expect(within(transcript()).getByText('Checking the queue.')).toBeInTheDocument();
    expect(checkinMock).toHaveBeenCalledWith('a1', 't1', 'c1');
  });

  it('says a check-in started outside its schedule, without saying who started it', async () => {
    checkinMock.mockResolvedValueOnce(page({ triggerSource: 'manual' }));
    const first = renderPage();
    // The whole line, so nothing else in it can name who started it: Check now
    // and the agent's own start both record 'manual' (decisions row 10).
    expect(
      within(await ready()).getByText('Caveman · Started outside its schedule · read-only'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/check now/i)).toBeNull();
    first.unmount();

    checkinMock.mockResolvedValueOnce(page({ triggerSource: 'webhook' }));
    renderPage();
    expect(
      within(await ready()).getByText('Caveman · Started by an update from another app · read-only'),
    ).toBeInTheDocument();
  });

  it('a check-in that didn’t finish says so, with its reason', async () => {
    checkinMock.mockResolvedValueOnce(
      page({ checkIn: checkIn({ status: 'error', error: 'The agent timed out.', report: null }) }),
    );
    const first = renderPage();
    let s = await ready();
    expect(within(s).getByText('This check-in didn’t finish.')).toBeInTheDocument();
    expect(within(s).getByText('The agent timed out.')).toBeInTheDocument();
    // It left no report, so it says nothing about how the task is going.
    expect(within(s).queryByText(/Needs you|On track|Off track/)).toBeNull();
    first.unmount();

    checkinMock.mockResolvedValueOnce(
      page({ checkIn: checkIn({ status: 'error', error: null, report: null }) }),
    );
    renderPage();
    s = await ready();
    expect(within(s).getByText('This check-in didn’t finish.')).toBeInTheDocument();
    expect(within(s).getByText('No reason was recorded.')).toBeInTheDocument();
  });

  it('shows the tools it ran', async () => {
    checkinMock.mockResolvedValue(
      page({
        thread: [
          {
            kind: 'steps',
            id: 'turn-2',
            text: '',
            at: FIRED,
            stepsLabel: '2 steps',
            steps: [
              { text: 'Ran pnpm test', status: 'done' },
              { text: 'Send email', status: 'failed' },
            ],
          },
        ],
      }),
    );
    renderPage();
    const steps = await screen.findByTestId('workspace-steps');
    expect(within(steps).getByText('2 steps')).toBeInTheDocument();
    expect(within(steps).getByText('Ran pnpm test')).toBeInTheDocument();
    expect(within(steps).getByText('Send email')).toBeInTheDocument();
  });

  it('offers no way to send, stop, retry or continue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      checkinMock.mockResolvedValue(page({ thread: [SAID, OPEN_ROW] }));
      renderPage({ decisions: [OPEN] });
      await ready();
      // The approval is drawn, draft and all, so this thread does have buttons.
      const t = transcript();
      expect(within(t).getByText('Original draft')).toBeInTheDocument();
      expect(within(t).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
      // No composer, no Stop, no Edit first, and no resend or retry anywhere.
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(
        screen.queryByRole('button', { name: /send|stop|resend|retry|continue|edit first/i }),
      ).toBeNull();
      expect(document.querySelector('[data-testid="composer-announcer"]')).toBeNull();
      // And it asks for nothing but its own read: no chat, no stream, no write.
      expect(checkinMock).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers an approval it is still waiting on, through the queue', async () => {
    checkinMock.mockResolvedValue(page({ thread: [SAID, OPEN_ROW] }));
    const always = { ...OPEN, approvalScopes: ['once' as const, 'agent-routines' as const] };
    const view = renderPage({ decisions: [always] });
    await ready();
    fireEvent.click(within(transcript()).getByRole('button', { name: 'Allow' }));
    expect(view.onApprove).toHaveBeenLastCalledWith('d1', undefined);
    // Always Allow keeps its scope: the page takes the queue's own handler.
    fireEvent.click(within(transcript()).getByRole('button', { name: 'Always Allow' }));
    expect(view.onApprove).toHaveBeenLastCalledWith('d1', 'agent-routines');
    fireEvent.click(within(transcript()).getByRole('button', { name: 'Leave it' }));
    expect(view.onDismiss).toHaveBeenCalledWith('d1');

    // The queue's in-flight rows and its notices reach the card.
    const notice = 'We couldn’t send that answer. Try again.';
    view.rerender(
      <TaskCheckinPage
        {...view.props}
        busyIds={new Set(['d1'])}
        notices={new Map([['d1', notice]])}
      />,
    );
    expect(within(transcript()).getByRole('button', { name: 'Allow' })).toBeDisabled();
    // On the card itself; the card's live region says it once more, out of sight.
    expect(within(screen.getByTestId('approval-d1')).getByText(notice)).toBeInTheDocument();

    // And an answer is taken back through the queue too: here, the Leave it above.
    view.rerender(
      <TaskCheckinPage {...view.props} decisions={[resolvedFixture('dismissed', { id: 'd1' })]} />,
    );
    fireEvent.click(within(transcript()).getByRole('button', { name: /^Undo/ }));
    expect(view.onUndo).toHaveBeenCalledWith('d1');
  });

  it('an approval it raised names its task, not that it is holding', async () => {
    // Every check-in decision is unattended: the run ended its turn rather
    // than wait, so the attended card's "I am holding here" would be false.
    expect(OPEN.attendance).toBe('unattended');
    // An hour left on the page's own clock, so the expiry note is drawn.
    const expiring = {
      ...OPEN,
      checkIn: { routineId: 't1', taskName: TASK_NAME },
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    };
    checkinMock.mockResolvedValue(page({ thread: [SAID, OPEN_ROW] }));
    renderPage({ decisions: [expiring] });
    await ready();
    const card = within(transcript()).getByTestId('approval-d1');
    expect(card).not.toHaveTextContent(/I am holding here/);
    expect(card).not.toHaveTextContent(/carry straight on/);
    expect(
      within(card).getByText(
        'Held during a check-in on “Zero open support tickets” · checked against: Thursday 9:30 still free for both of you',
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText('If nobody answers, it expires in about an hour and has to be asked again.'),
    ).toBeInTheDocument();
  });

  it('a file it made downloads under the check-in the server found, not the address as typed', async () => {
    // The server trims the id it is handed; the address may not be.
    const fetchMock = vi.fn(async () => new Response('csv'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      checkinMock.mockResolvedValue(
        page({
          thread: [
            {
              ...SAID,
              attachments: [{ path: 'out/report.csv', displayName: 'report.csv', mediaType: 'text/csv' }],
            },
          ],
        }),
      );
      renderPage({ conversationId: ' c1 ' });
      await ready();
      expect(checkinMock).toHaveBeenCalledWith('a1', 't1', ' c1 ');
      fireEvent.click(within(transcript()).getByRole('button', { name: 'Download report.csv' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/files?path=out%2Freport.csv&conversationId=c1',
        expect.anything(),
      );
      await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws the agent’s words as the agent view does, and its report as plain text', async () => {
    const raw = '**bold** <b>x</b>';
    checkinMock.mockResolvedValue(
      page({
        checkIn: checkIn({ report: { status: 'on-track', update: raw } }),
        thread: [
          {
            kind: 'agent',
            id: 'turn-2',
            text: '**Done** ![x](https://x.test/a.png) <img src=x onerror=alert(1)>',
            at: FIRED,
          },
        ],
      }),
    );
    renderPage();
    const s = await ready();
    // The transcript is the agent view's markdown: bold is bold, and an image is
    // only its alt text, so nothing the model wrote makes the browser fetch.
    expect(within(transcript()).getByText('Done').tagName).toBe('STRONG');
    expect(document.querySelectorAll('img')).toHaveLength(0);
    // The report is text, character for character.
    expect(within(s).getByText(raw).textContent).toBe(raw);
    expect(s.querySelector('strong, b')).toBeNull();
  });

  it('says when there’s nothing else to show', async () => {
    checkinMock.mockResolvedValue(page({ thread: [] }));
    renderPage();
    await ready();
    expect(screen.getByText('There’s nothing else to show from this check-in.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Conversation with Caveman' })).toBeNull();
  });

  it('a check-in its instructions blocked reads as that', async () => {
    checkinMock.mockResolvedValue(
      page({
        checkIn: checkIn({ status: 'error', error: BRIEF_DIDNT_LOAD, report: null }),
        thread: [
          { kind: 'error', id: 'turn-1:error', reason: 'system-prompt:brief-missing', at: FIRED },
        ],
      }),
    );
    renderPage();
    const s = await ready();
    // The row in the transcript and the summary above it say the same thing.
    expect(within(transcript()).getByText(BRIEF_DIDNT_LOAD)).toBeInTheDocument();
    expect(within(s).getByText(BRIEF_DIDNT_LOAD)).toBeInTheDocument();
    // Nothing stopped, and there is nothing to retry.
    expect(screen.queryByText(/stopped unexpectedly/i)).toBeNull();
    expect(screen.queryByText(/retry/i)).toBeNull();
  });

  it('the crumbs lead back to Tasks and to the task', async () => {
    checkinMock.mockResolvedValue(page());
    const { onNavigate } = renderPage();
    await ready();
    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' });
    const tasks = within(crumbs).getByRole('link', { name: 'Tasks' });
    const task = within(crumbs).getByRole('link', { name: TASK_NAME });
    expect(tasks).toHaveAttribute('href', '/workspace/tasks');
    expect(task).toHaveAttribute('href', '/workspace/tasks/a1/t1');
    // Clamped on screen, so the whole name is on hover.
    expect(task).toHaveAttribute('title', TASK_NAME);
    fireEvent.click(tasks);
    fireEvent.click(task);
    expect(onNavigate.mock.calls).toEqual([
      [{ kind: 'tasks' }],
      [{ kind: 'task', agentId: 'a1', routineId: 't1' }],
    ]);
  });

  it('says only that it’s a check-in while it loads, and when its time can’t be read', async () => {
    checkinMock.mockReturnValueOnce(new Promise<TaskCheckin>(() => {}));
    const first = renderPage();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Check-in' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Task' })).toHaveAttribute(
      'href',
      '/workspace/tasks/a1/t1',
    );
    first.unmount();

    checkinMock.mockResolvedValueOnce(page({ checkIn: checkIn({ firedAt: 'not a time' }) }));
    renderPage();
    await screen.findByRole('region', { name: 'How this check-in went' });
    expect(screen.getByRole('heading', { level: 1, name: 'Check-in' })).toBeInTheDocument();
  });

  it('a check-in that isn’t there or isn’t yours says so, with no Try again', async () => {
    checkinMock.mockRejectedValue(new WorkspaceApiError(CHECKIN_PATH, 404));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'We couldn’t find this check-in. It may be too old to open here, or it belongs to someone else.',
    );
    expect(alert.className).toContain('destructive');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Check-in' })).toBeInTheDocument();
  });

  it('a failed read offers Try again, and an expired session asks to sign in again', async () => {
    checkinMock
      .mockRejectedValueOnce(new WorkspaceApiError(CHECKIN_PATH, 500))
      .mockResolvedValueOnce(page());
    const first = renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load this check-in just now. Nothing was lost.');
    expect(alert.className).toContain('destructive');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
    first.unmount();

    checkinMock.mockReset();
    checkinMock.mockRejectedValue(new WorkspaceApiError(CHECKIN_PATH, 401));
    renderPage();
    const expired = await screen.findByRole('alert');
    expect(expired).toHaveTextContent(HTTP_SESSION_ENDED);
    expect(expired.className).not.toContain('destructive');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a re-read that fails keeps the check-in on screen, says so, and offers Try again', async () => {
    checkinMock
      .mockResolvedValueOnce(page({ decisions: { status: 'failed' } }))
      .mockRejectedValueOnce(new WorkspaceApiError(CHECKIN_PATH, 500))
      .mockResolvedValueOnce(page());
    renderPage();
    await ready();
    fireEvent.click(within(transcript()).getByRole('button', { name: 'Try again' }));
    const line = await screen.findByText(REFRESH_FAILED);
    // What it read before is still there.
    expect(
      screen.getByRole('heading', { level: 1, name: `Check-in at ${localTime(FIRED)}` }),
    ).toBeInTheDocument();
    expect(within(transcript()).getByText('Checking the queue.')).toBeInTheDocument();
    const alert = line.closest('[role="alert"]') as HTMLElement;
    expect(alert.className).toContain('destructive');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(checkinMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText(REFRESH_FAILED)).toBeNull());
  });

  it('Try again under its approvals reads the queue and the check-in again', async () => {
    checkinMock.mockResolvedValue(page({ decisions: { status: 'failed' } }));
    const { onRetryDecisions } = renderPage();
    await ready();
    const t = transcript();
    expect(within(t).getByText(DECISION_THREAD_READ_FAILED)).toBeInTheDocument();
    fireEvent.click(within(t).getByRole('button', { name: 'Try again' }));
    expect(onRetryDecisions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(checkinMock).toHaveBeenCalledTimes(2));
  });

  it('a queue read the session ran out on asks to sign in, not to try again', async () => {
    checkinMock.mockResolvedValue(page());
    renderPage({ decisionsError: { kind: 'expired', detail: '' } });
    await ready();
    const t = transcript();
    expect(within(t).getByText(DECISION_SESSION_EXPIRED)).toBeInTheDocument();
    expect(within(t).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
