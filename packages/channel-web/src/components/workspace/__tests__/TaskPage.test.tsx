/**
 * A "Stay on top of something" task's own page (TASK-910): its latest update,
 * its brief and notes, its Updates thread, Check now and Pause/Resume, and
 * (TASK-931) the reply box and "Checking in now…".
 *
 * Driven through the REAL `useTask`, `TaskNotes` and `TaskUpdates`, with only
 * the network mocked, so each case is what the reader would actually see. The
 * copy is asserted verbatim because it is decided (TASK-910 plan, Task 12),
 * and its apostrophe is U+2019, not the ASCII one.
 *
 * Times are built in the reader's own calendar (`new Date(y, m, d, …)`) and
 * the expected words from `localTime`, so nothing depends on where or when the
 * suite runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { routineApi, RoutineApiError, type Routine } from '@/lib/routines';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { finishByLine } from '@/lib/task-finish-by';
import { localTime } from '@/lib/workspace-time';
import type { TaskDetail, TaskDetailReport, TaskNoRecentUpdate } from '@/lib/workspace-types';
import { TaskPage } from '../TaskPage';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      task: vi.fn(),
      clearTaskNotes: vi.fn(),
      sendTaskReply: vi.fn(),
      setTaskSteps: vi.fn(),
      setTaskFinishBy: vi.fn(),
    },
  };
});

vi.mock('@/lib/routines', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/routines');
  return { ...actual, routineApi: { fireNow: vi.fn(), update: vi.fn() } };
});

const taskMock = vi.mocked(workspaceApi.task);
const clearMock = vi.mocked(workspaceApi.clearTaskNotes);
const replyMock = vi.mocked(workspaceApi.sendTaskReply);
const stepsMock = vi.mocked(workspaceApi.setTaskSteps);
const finishByMock = vi.mocked(workspaceApi.setTaskFinishBy);
const fireNowMock = vi.mocked(routineApi.fireNow);
const updateMock = vi.mocked(routineApi.update);

const NOW = new Date(2026, 9, 22, 12, 0);
const REPORTED = new Date(2026, 9, 22, 10, 2).toISOString();
const NEXT = new Date(2026, 9, 22, 13, 0).toISOString();
const TASK_PATH = '/tasks/a1/t1';
/** What `routineApi.update` answers. The page reads the task again instead. */
const ROUTINE = {} as Routine;

const CHECKING_IN = 'Checking in now…';
const PAUSED_NOTE = 'Paused. It won’t check in until you resume it.';
const PAUSED_NO_EDIT_NOTE = 'Paused. Only someone who manages this agent’s tasks can resume it.';
const NO_MANAGE_NOTE =
  'You can’t start or pause this task’s check-ins, because you no longer manage this agent’s tasks.';

function report(over: Partial<TaskDetailReport> = {}): TaskDetailReport {
  return {
    status: 'needs-you',
    update: '3 open. I’m answering #4411 and #4412 now.',
    ask: 'Want me to draft a reply to #4410 for you to send?',
    agentNotes: 'Ticket 4410 is from an enterprise customer.\nLeave it for Sam.',
    reading: null,
    reportedAt: REPORTED,
    ...over,
  };
}

/** Quill's support-queue task, reported once, unless `over` says otherwise. */
function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    agentName: 'Quill',
    name: 'Zero open support tickets',
    kind: 'stay-on-top',
    enabled: true,
    revision: 'rev-1',
    permissions: { fire: true, stop: true, edit: true },
    schedule: 'every hour, 9:00 AM to 6:00 PM (America/New_York)',
    nextCheckAt: NEXT,
    brief: {
      promptBody: 'Keep the support queue empty.\nLeave refunds over $100 to me.',
      goodWhen: 'No ticket is open longer than an hour.',
    },
    task: report(),
    steps: [],
    finishBy: null,
    noRecentUpdate: null,
    updates: [
      {
        firedAt: REPORTED,
        status: 'ok',
        error: null,
        report: { status: 'needs-you', update: '3 open. I’m answering #4411 and #4412 now.', reading: null },
        conversationId: null,
      },
    ],
    replies: [],
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage() {
  const onNavigate = vi.fn<(route: WorkspaceRoute) => void>();
  const view = render(
    <TaskPage
      agentId="a1"
      routineId="t1"
      leading={<button type="button">Open navigation</button>}
      onNavigate={onNavigate}
    />,
  );
  return { ...view, onNavigate };
}

/** Render, and wait for the task to be on screen. */
async function renderReady() {
  const view = renderPage();
  await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });
  return view;
}

function latestUpdate(): HTMLElement {
  return screen.getByRole('region', { name: 'Latest update' });
}

/** The page's own live line. The reply box has one too, later in the document (TASK-931). */
function pageStatus(): HTMLElement {
  return screen.getAllByRole('status')[0]!;
}

/**
 * Where a real browser leaves focus once the button just pressed goes
 * disabled: `<body>`. jsdom keeps focus on a disabled button (and its `blur()`
 * does nothing there), so the drop is made by hand: a decoy takes focus and
 * leaves the document, and jsdom hands focus to `<body>` as a browser does.
 */
function dropFocusOnBody() {
  const decoy = document.createElement('button');
  document.body.append(decoy);
  act(() => decoy.focus());
  act(() => decoy.remove());
  expect(document.activeElement).toBe(document.body);
}

/** Wait until a press has settled and the page has read the task again. */
async function settled(button: HTMLElement, reads: number) {
  await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(reads));
  await waitFor(() => expect(button).toBeEnabled());
}

let warn: MockInstance;

beforeEach(() => {
  taskMock.mockReset();
  clearMock.mockReset();
  replyMock.mockReset();
  stepsMock.mockReset();
  finishByMock.mockReset();
  fireNowMock.mockReset();
  updateMock.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // Failed reads and presses are logged, and several cases fail on purpose.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('TaskPage (TASK-910)', () => {
  it('shows the latest update, when it checked and checks next, and the ask in the agent’s words', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByRole('heading', { level: 2, name: 'Latest update' })).toHaveClass(
      'sr-only',
    );
    expect(within(latest).getByText('Needs you')).toBeInTheDocument();
    expect(within(latest).getByText('3 open. I’m answering #4411 and #4412 now.')).toBeInTheDocument();
    expect(
      within(latest).getByText(
        `Checked at ${localTime(REPORTED)} · Next check at ${localTime(NEXT)}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(latest).getByText('Quill asks: Want me to draft a reply to #4410 for you to send?'),
    ).toBeInTheDocument();
    expect(taskMock).toHaveBeenCalledWith('a1', 't1');
  });

  it('a report it can’t show says so, and a report with no ask asks nothing', async () => {
    taskMock.mockResolvedValue(detail({ task: report({ update: null, ask: null }) }));
    await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByText('It left an update we can’t show.')).toBeInTheDocument();
    expect(within(latest).queryByText(/asks:/)).toBeNull();
  });

  it('says there is no update yet, and when it will first check in', async () => {
    taskMock.mockResolvedValue(detail({ task: null, updates: [] }));
    await renderReady();
    expect(
      within(latestUpdate()).getByText(`No update yet. It’ll check in at ${localTime(NEXT)}.`),
    ).toBeInTheDocument();
  });

  it('the latest update links to the check-in it came from', async () => {
    const said = '3 open. I’m answering #4411 and #4412 now.';
    taskMock.mockResolvedValue(
      detail({
        updates: [
          {
            firedAt: REPORTED,
            status: 'ok',
            error: null,
            report: { status: 'needs-you', update: said, reading: null },
            conversationId: 'c1',
          },
        ],
      }),
    );
    const { onNavigate } = await renderReady();
    const link = within(latestUpdate()).getByRole('link', { name: 'See what it did' });
    expect(link).toHaveAttribute('href', '/workspace/tasks/a1/t1/checkins/c1');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'task-checkin',
      agentId: 'a1',
      routineId: 't1',
      conversationId: 'c1',
    });
  });

  // A check-in still running when the page loaded has already reported, but it
  // isn't in Updates until it finishes (decisions row 12).
  it('no link while a check-in with a new update is still running', async () => {
    taskMock.mockResolvedValue(
      detail({
        task: report({ update: 'Just now: 2 open.' }),
        updates: [
          {
            firedAt: REPORTED,
            status: 'ok',
            error: null,
            report: { status: 'needs-you', update: '3 open. I’m answering #4411 and #4412 now.', reading: null },
            conversationId: 'c1',
          },
        ],
      }),
    );
    await renderReady();
    expect(within(latestUpdate()).queryByRole('link')).toBeNull();
  });

  it('a paused task says so where it would say when it checks next', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null }));
    await renderReady();
    expect(
      within(latestUpdate()).getByText(`Checked at ${localTime(REPORTED)} · Paused`),
    ).toBeInTheDocument();
  });

  it('a paused task that never reported only says there is no update yet', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null, task: null }));
    await renderReady();
    expect(within(latestUpdate()).getByText('No update yet.')).toBeInTheDocument();
  });

  it('names the agent, the kind of task and how often it checks in', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    expect(
      screen.getByText(
        'Quill · Stay on top of something · checks in every hour, 9:00 AM to 6:00 PM (America/New_York)',
      ),
    ).toBeInTheDocument();
    // Below `md` the shell's nav trigger is the only door to the sidebar.
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });

  it('leaves out how often a task checks in when it doesn’t on a schedule', async () => {
    taskMock.mockResolvedValue(detail({ schedule: null }));
    await renderReady();
    expect(screen.getByText('Quill · Stay on top of something')).toBeInTheDocument();
  });

  it('shows the brief as written, read-only, with a way to change it in the agent’s settings', async () => {
    taskMock.mockResolvedValue(detail());
    const { onNavigate } = await renderReady();
    const brief = screen.getByRole('region', { name: 'About this task' });
    expect(within(brief).getByText('What Quill does')).toBeInTheDocument();
    expect(
      within(brief).getByText(/Keep the support queue empty\./).textContent,
    ).toBe('Keep the support queue empty.\nLeave refunds over $100 to me.');
    expect(within(brief).getByText('Going well when')).toBeInTheDocument();
    expect(within(brief).getByText('No ticket is open longer than an hour.')).toBeInTheDocument();
    expect(within(brief).getByText('Quill’s notes')).toBeInTheDocument();
    expect(within(brief).queryByRole('textbox')).toBeNull();

    const settings = within(brief).getByRole('link', { name: 'Change these in Quill’s settings' });
    expect(settings).toHaveAttribute('href', '/workspace/agents/a1/settings/routines');
    fireEvent.click(settings);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'agent-settings',
      id: 'a1',
      section: 'routines',
    });
  });

  it('a brief with nothing saved says so', async () => {
    taskMock.mockResolvedValue(detail({ brief: { promptBody: null, goodWhen: null } }));
    await renderReady();
    const brief = screen.getByRole('region', { name: 'About this task' });
    expect(within(brief).getByText('No instructions saved.')).toBeInTheDocument();
    expect(within(brief).getByText('Nothing saved.')).toBeInTheDocument();
  });

  it('Check now starts a check-in with the task’s current revision, then reads the task again', async () => {
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockResolvedValue({ status: 'ok' });
    await renderReady();
    // Mounted before there is anything to say: a region inserted already
    // holding its message is the announcement screen readers drop most often.
    const said = pageStatus();
    expect(said).toBeEmptyDOMElement();

    const check = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    expect(await screen.findByText(CHECKING_IN)).toBeInTheDocument();
    expect(pageStatus()).toBe(said);
    expect(said).toHaveTextContent(CHECKING_IN);
    expect(fireNowMock).toHaveBeenCalledTimes(1);
    expect(fireNowMock).toHaveBeenCalledWith({
      agentId: 'a1',
      routineId: 't1',
      expectedRevision: 'rev-1',
      requestId: expect.any(String),
    });
    await settled(check, 2);
  });

  it('only one action runs at a time', async () => {
    const fired = deferred<{ status: 'ok' }>();
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockReturnValueOnce(fired.promise);
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    const pause = screen.getByRole('button', { name: 'Pause' });
    fireEvent.click(check);
    expect(check).toBeDisabled();
    expect(pause).toBeDisabled();
    fireEvent.click(pause);
    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => fired.resolve({ status: 'ok' }));
    await settled(pause, 2);
    expect(check).toBeEnabled();
    expect(fireNowMock).toHaveBeenCalledTimes(1);
  });

  it('the next press waits for the re-read, so it carries the revision just read', async () => {
    const reread = deferred<TaskDetail>();
    taskMock
      .mockResolvedValueOnce(detail())
      .mockReturnValueOnce(reread.promise)
      .mockResolvedValue(detail({ enabled: false, revision: 'rev-3', nextCheckAt: null }));
    fireNowMock.mockResolvedValue({ status: 'ok' });
    updateMock.mockResolvedValue(ROUTINE);
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    const pause = screen.getByRole('button', { name: 'Pause' });

    fireEvent.click(check);
    await screen.findByText(CHECKING_IN);
    // The check-in has started, and the page is reading the task again.
    expect(check).toBeDisabled();
    expect(pause).toBeDisabled();
    fireEvent.click(pause);
    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => reread.resolve(detail({ revision: 'rev-2' })));
    expect(pause).toBeEnabled();
    fireEvent.click(pause);
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0]![0].expectedRevision).toBe('rev-2');
  });

  it('each press clears what the last one said, so the same answer is heard again', async () => {
    const second = deferred<{ status: 'ok' }>();
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockResolvedValueOnce({ status: 'ok' }).mockReturnValueOnce(second.promise);
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    const said = pageStatus();
    fireEvent.click(check);
    await waitFor(() => expect(said).toHaveTextContent(CHECKING_IN));
    await settled(check, 2);

    fireEvent.click(check);
    // The same words left standing would change nothing, so say nothing.
    expect(said).toBeEmptyDOMElement();
    await act(async () => second.resolve({ status: 'ok' }));
    expect(said).toHaveTextContent(CHECKING_IN);
  });

  it('a Check now that couldn’t be confirmed is retried with the same request, so it can’t start twice', async () => {
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockRejectedValueOnce(new RoutineApiError(0)).mockResolvedValueOnce({ status: 'ok' });
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });

    fireEvent.click(check);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'We couldn’t confirm the check-in started. Try again, and it won’t start twice.',
    );
    expect(alert.className).toContain('destructive');
    await settled(check, 2);

    fireEvent.click(check);
    expect(await screen.findByText(CHECKING_IN)).toBeInTheDocument();
    expect(fireNowMock).toHaveBeenCalledTimes(2);
    expect(fireNowMock.mock.calls[1]![0]).toEqual(fireNowMock.mock.calls[0]![0]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an unconfirmed Check now’s request even when the task changed meanwhile, and starts afresh once refused', async () => {
    // The first press may have started a check-in. Only the same request can
    // find out without starting a second one: its receipt is keyed by it.
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ revision: 'rev-2' }))
      .mockResolvedValue(detail({ revision: 'rev-2' }));
    fireNowMock
      .mockRejectedValueOnce(new RoutineApiError(0))
      .mockRejectedValueOnce(new RoutineApiError(409, 'revision-conflict'))
      .mockResolvedValueOnce({ status: 'ok' });
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });

    fireEvent.click(check);
    await settled(check, 2);
    fireEvent.click(check);
    expect(
      await screen.findByText(
        'This task changed while you had it open. We’ve loaded the latest, so try again.',
      ),
    ).toBeInTheDocument();
    expect(fireNowMock.mock.calls[1]![0]).toEqual(fireNowMock.mock.calls[0]![0]);
    await settled(check, 3);

    fireEvent.click(check);
    expect(await screen.findByText(CHECKING_IN)).toBeInTheDocument();
    const third = fireNowMock.mock.calls[2]![0];
    expect(third.expectedRevision).toBe('rev-2');
    expect(third.requestId).not.toBe(fireNowMock.mock.calls[0]![0].requestId);
  });

  it('Pause, then Resume, flips the task with each read’s revision', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ enabled: false, revision: 'rev-2', nextCheckAt: null }))
      .mockResolvedValue(detail({ revision: 'rev-3' }));
    updateMock.mockResolvedValue(ROUTINE);
    await renderReady();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const resume = await screen.findByRole('button', { name: 'Resume' });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenLastCalledWith({
      agentId: 'a1',
      routineId: 't1',
      expectedRevision: 'rev-1',
      requestId: expect.any(String),
      patch: { enabled: false },
    });
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await settled(resume, 2);

    fireEvent.click(resume);
    await screen.findByRole('button', { name: 'Pause' });
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith({
      agentId: 'a1',
      routineId: 't1',
      expectedRevision: 'rev-2',
      requestId: expect.any(String),
      patch: { enabled: true },
    });
    expect(updateMock.mock.calls[1]![0].requestId).not.toBe(updateMock.mock.calls[0]![0].requestId);
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(3));
  });

  it('a keyboard user who pauses is left on Resume, not at the top of the page', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ enabled: false, revision: 'rev-2', nextCheckAt: null }));
    updateMock.mockResolvedValue(ROUTINE);
    await renderReady();
    const pause = screen.getByRole('button', { name: 'Pause' });
    pause.focus();
    fireEvent.click(pause);
    dropFocusOnBody();

    const resume = await screen.findByRole('button', { name: 'Resume' });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    // Said by the button it lands on, not by a line that is also announced.
    expect(pageStatus()).toBeEmptyDOMElement();
  });

  it('a press that leaves nothing to press lands on the line that says why', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ permissions: { fire: false, stop: false, edit: false } }));
    fireNowMock.mockRejectedValue(new RoutineApiError(404, 'forbidden'));
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    check.focus();
    fireEvent.click(check);
    dropFocusOnBody();

    const note = await screen.findByText(NO_MANAGE_NOTE);
    await waitFor(() => expect(document.activeElement).toBe(note));
    // Focus reads it; a live region as well would say it twice (TASK-651).
    expect(note.closest('[role="status"], [aria-live]')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('You can’t change this task any more.');
  });

  it('someone who moved on while a press ran stays where they went', async () => {
    const fired = deferred<{ status: 'ok' }>();
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockReturnValueOnce(fired.promise);
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    check.focus();
    fireEvent.click(check);
    const show = screen.getByRole('button', { name: 'Show Quill’s notes' });
    show.focus();

    await act(async () => fired.resolve({ status: 'ok' }));
    await settled(check, 2);
    expect(document.activeElement).toBe(show);
  });

  it('Check now is disabled while paused, and says why', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null }));
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    expect(check).toBeDisabled();
    expect(check).toHaveAccessibleDescription(PAUSED_NOTE);
    expect(screen.getByText(PAUSED_NOTE)).toBeInTheDocument();
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume).toBeEnabled();
    expect(resume).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it.each([
    {
      what: 'a running task',
      over: { enabled: true },
      note: NO_MANAGE_NOTE,
      buttons: ['Check now', 'Pause'],
    },
    {
      what: 'a paused task',
      over: { enabled: false, nextCheckAt: null },
      note: PAUSED_NO_EDIT_NOTE,
      buttons: ['Check now', 'Resume'],
    },
  ])(
    'someone who no longer manages the agent’s tasks sees why nothing can be started or resumed: $what',
    async ({ over, note, buttons }) => {
      taskMock.mockResolvedValue(
        detail({ ...over, permissions: { fire: false, stop: false, edit: false } }),
      );
      await renderReady();
      expect(screen.getByText(note)).toBeInTheDocument();
      for (const name of buttons) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(note);
      }
    },
  );

  it('Resume needs edit, whatever else the person may do', async () => {
    taskMock.mockResolvedValue(
      detail({
        enabled: false,
        nextCheckAt: null,
        permissions: { fire: true, stop: true, edit: false },
      }),
    );
    await renderReady();
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription(PAUSED_NO_EDIT_NOTE);
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('a task that can be started and paused needs no note', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    for (const note of [PAUSED_NOTE, PAUSED_NO_EDIT_NOTE, NO_MANAGE_NOTE]) {
      expect(screen.queryByText(note)).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Check now' })).not.toHaveAttribute(
      'aria-describedby',
    );
    expect(screen.getByRole('button', { name: 'Pause' })).not.toHaveAttribute('aria-describedby');
  });

  it('a task changed elsewhere says so and loads the latest', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValue(detail({ revision: 'rev-2', name: 'Zero open tickets, edited' }));
    updateMock
      .mockRejectedValueOnce(new RoutineApiError(409, 'revision-conflict'))
      .mockResolvedValueOnce(ROUTINE);
    await renderReady();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This task changed while you had it open. We’ve loaded the latest, so try again.',
    );
    expect(alert.className).toContain('destructive');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Zero open tickets, edited' }),
    ).toBeInTheDocument();

    // The next press is a new request, against the revision just loaded.
    const pause = screen.getByRole('button', { name: 'Pause' });
    await settled(pause, 2);
    fireEvent.click(pause);
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(2));
    const second = updateMock.mock.calls[1]![0];
    expect(second.expectedRevision).toBe('rev-2');
    expect(second.requestId).not.toBe(updateMock.mock.calls[0]![0].requestId);
  });

  it.each([
    {
      what: 'a Check now on a task paused elsewhere',
      press: 'Check now',
      failure: new RoutineApiError(400, 'disabled'),
      says: 'This task is paused, so it can’t check in. Resume it first.',
    },
    {
      what: 'a Check now on a task that is no longer theirs',
      press: 'Check now',
      failure: new RoutineApiError(404, 'forbidden'),
      says: 'You can’t change this task any more.',
    },
    {
      what: 'a Pause on a task that is gone',
      press: 'Pause',
      failure: new RoutineApiError(404, 'not-found'),
      says: 'You can’t change this task any more.',
    },
    {
      what: 'a Pause the server couldn’t answer',
      press: 'Pause',
      failure: new RoutineApiError(503, 'unavailable'),
      says: 'We couldn’t confirm that change. Try again.',
    },
    {
      what: 'a Pause whose answer couldn’t be read',
      press: 'Pause',
      failure: new SyntaxError('Unexpected end of JSON input'),
      says: 'We couldn’t confirm that change. Try again.',
    },
    {
      what: 'a Pause refused for another reason',
      press: 'Pause',
      failure: new RoutineApiError(409, 'cleanup-pending'),
      says: 'We couldn’t pause this task just now. Try again.',
    },
    {
      what: 'a Check now refused for another reason',
      press: 'Check now',
      failure: new RoutineApiError(400, 'validation'),
      says: 'We couldn’t start the check-in. Try again.',
    },
  ])('a press that fails says what happened in plain words: $what', async ({ press, failure, says }) => {
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockRejectedValue(failure);
    updateMock.mockRejectedValue(failure);
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: press }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(says);
    expect(alert.className).toContain('destructive');
    // `RoutineApiError.message` speaks of routines; this page never says it.
    expect(document.body.textContent).not.toMatch(/routine/i);
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
  });

  it('a Resume refused for another reason says it couldn’t resume', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null }));
    updateMock.mockRejectedValue(new RoutineApiError(409, 'cleanup-pending'));
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t resume this task just now. Try again.',
    );
  });

  it('a check-in that couldn’t start says so, and the next press is a new request', async () => {
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockResolvedValueOnce({ status: 'error' }).mockResolvedValueOnce({ status: 'ok' });
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t start the check-in. Try again.');
    expect(alert.className).toContain('destructive');
    await settled(check, 2);

    fireEvent.click(check);
    expect(await screen.findByText(CHECKING_IN)).toBeInTheDocument();
    expect(fireNowMock.mock.calls[1]![0].requestId).not.toBe(
      fireNowMock.mock.calls[0]![0].requestId,
    );
  });

  it('a press after the session ended asks to sign in again, in the quiet register', async () => {
    taskMock.mockResolvedValue(detail());
    updateMock.mockRejectedValue(new RoutineApiError(401));
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(HTTP_SESSION_ENDED);
    expect(alert.className).not.toContain('destructive');
  });

  it('draws what the agent wrote as plain text', async () => {
    const raw = '**Done** <b>3</b> [docs](https://x.test) <img src=x onerror=alert(1)>';
    taskMock.mockResolvedValue(
      detail({
        name: `Name ${raw}`,
        brief: { promptBody: `Does ${raw}`, goodWhen: `Well ${raw}` },
        task: report({ update: `Update ${raw}`, ask: `Ask ${raw}`, agentNotes: `Notes ${raw}` }),
        updates: [],
      }),
    );
    renderPage();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).toBe(`Name ${raw}`);
    const latest = latestUpdate();
    expect(within(latest).getByText(`Update ${raw}`).textContent).toBe(`Update ${raw}`);
    expect(within(latest).getByText(`Quill asks: Ask ${raw}`).textContent).toBe(
      `Quill asks: Ask ${raw}`,
    );
    expect(screen.getByText(`Does ${raw}`).textContent).toBe(`Does ${raw}`);
    expect(screen.getByText(`Well ${raw}`).textContent).toBe(`Well ${raw}`);
    fireEvent.click(screen.getByRole('button', { name: 'Show Quill’s notes' }));
    expect(screen.getByText(`Notes ${raw}`).textContent).toBe(`Notes ${raw}`);
    expect(document.querySelector('strong, b, img')).toBeNull();
    expect(document.querySelector('a[href="https://x.test"]')).toBeNull();
  });

  it('a task that isn’t there or isn’t yours says so, with no Try again', async () => {
    taskMock.mockRejectedValue(new WorkspaceApiError(TASK_PATH, 404));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'We couldn’t find this task. It may have been deleted, or it belongs to someone else.',
    );
    expect(alert.className).toContain('destructive');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Task' })).toBeInTheDocument();
  });

  it('a failed read offers Try again, and an expired session asks to sign in again', async () => {
    taskMock
      .mockRejectedValueOnce(new WorkspaceApiError(TASK_PATH, 500))
      .mockResolvedValueOnce(detail());
    const first = renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load this task just now. Nothing was lost.');
    expect(alert.className).toContain('destructive');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    first.unmount();

    taskMock.mockReset();
    taskMock.mockRejectedValue(new WorkspaceApiError(TASK_PATH, 401));
    renderPage();
    const expired = await screen.findByRole('alert');
    expect(expired).toHaveTextContent(HTTP_SESSION_ENDED);
    expect(expired.className).not.toContain('destructive');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a re-read that fails keeps the task on screen, says so, and offers Try again', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new WorkspaceApiError(TASK_PATH, 500))
      .mockResolvedValueOnce(detail());
    fireNowMock.mockResolvedValue({ status: 'ok' });
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    const alert = await screen.findByText(
      'We couldn’t refresh this task just now, so what you see may be out of date.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Zero open support tickets' })).toBeInTheDocument();
    const again = within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', {
      name: 'Try again',
    });
    fireEvent.click(again);
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        screen.queryByText(
          'We couldn’t refresh this task just now, so what you see may be out of date.',
        ),
      ).toBeNull(),
    );
  });

  it('the Tasks crumb goes back to Tasks', async () => {
    taskMock.mockReturnValue(new Promise<TaskDetail>(() => {}));
    const { onNavigate } = renderPage();
    // There while the task loads, and the title says only that it's a task.
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Task' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' });
    const crumb = within(crumbs).getByRole('link', { name: 'Tasks' });
    expect(crumb).toHaveAttribute('href', '/workspace/tasks');
    fireEvent.click(crumb);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'tasks' });
    // A modified click opens a new tab: that one is the browser's.
    fireEvent.click(crumb, { ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('clearing the notes reads the task again', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ task: report({ agentNotes: null }) }));
    clearMock.mockResolvedValue({ cleared: true });
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Show Quill’s notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear notes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear notes' }));
    expect(await screen.findByText('Notes cleared.')).toBeInTheDocument();
    expect(clearMock).toHaveBeenCalledWith('a1', 't1');
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('None. It keeps notes here between check-ins.'),
    ).toBeInTheDocument();
  });

  it('shows the Updates thread', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    const updates = screen.getByRole('region', { name: 'Updates' });
    expect(
      within(updates).getByText('3 open. I’m answering #4411 and #4412 now.'),
    ).toBeInTheDocument();
  });
});

describe('TaskPage: a get-done task (TASK-948)', () => {
  const STEPS = [
    { id: 's1', text: 'Export every article', done: true, byAgent: true },
    { id: 's2', text: 'Check the redirects', done: false, byAgent: false },
  ];

  it('names a get-done task’s kind, and shows its steps between the latest update and the brief (TASK-948)', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS }));
    await renderReady();
    expect(
      screen.getByText(
        'Quill · Get something done · checks in every hour, 9:00 AM to 6:00 PM (America/New_York)',
      ),
    ).toBeInTheDocument();
    const steps = screen.getByRole('heading', { level: 2, name: 'Steps · 1 of 2 done' });
    const after = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after(latestUpdate(), steps)).toBeTruthy();
    expect(after(steps, screen.getByRole('region', { name: 'About this task' }))).toBeTruthy();
    expect(screen.getByText('Check the redirects')).toBeInTheDocument();
  });

  // TASK-952 landed first: its reading block sits right under the latest update it came with, so a
  // get-done page reads update, reading, steps, then the brief.
  it('draws the agent’s reading under the latest update, then the steps, then the brief', async () => {
    taskMock.mockResolvedValue(
      detail({ kind: 'get-done', steps: STEPS, task: report({ reading: { label: 'Articles moved', value: 40 } }) }),
    );
    await renderReady();
    const reading = screen.getByRole('region', { name: 'Quill’s reading' });
    const steps = screen.getByRole('heading', { level: 2, name: 'Steps · 1 of 2 done' });
    const brief = screen.getByRole('region', { name: 'About this task' });
    const after = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after(latestUpdate(), reading)).toBeTruthy();
    expect(after(reading, steps)).toBeTruthy();
    expect(after(steps, brief)).toBeTruthy();
  });

  it('a stay-on-top page has no steps section, and keeps its kind line', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    expect(screen.queryByRole('heading', { name: /^Steps/ })).toBeNull();
    expect(
      screen.getByText(
        'Quill · Stay on top of something · checks in every hour, 9:00 AM to 6:00 PM (America/New_York)',
      ),
    ).toBeInTheDocument();
  });

  it('a paused get-done task with no schedule still names its kind', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done', schedule: null }));
    await renderReady();
    expect(screen.getByText('Quill · Get something done')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Steps' })).toBeInTheDocument();
  });

  it('a tick on a get-done page shows the answer’s steps without reading the task again (TASK-949)', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS }));
    stepsMock.mockResolvedValue({ steps: STEPS.map((step) => ({ ...step, done: true })), skipped: 0 });
    await renderReady();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check the redirects' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Steps · 2 of 2 done' }),
    ).toBeInTheDocument();
    expect(stepsMock).toHaveBeenCalledWith('a1', 't1', {
      requestId: expect.any(String),
      ops: [{ op: 'tick', id: 's2' }],
    });
    expect(screen.getByRole('checkbox', { name: 'Check the redirects' })).toBeChecked();
    expect(taskMock).toHaveBeenCalledTimes(1);
  });
});

describe('TaskPage: a get-done task’s finish date (TASK-951)', () => {
  const FB = { date: '2026-11-14', daysLeft: 23 };

  it('a get-done task shows its finish date under the meta line; a stay-on-top task shows no finish date at all', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done', finishBy: FB }));
    const view = await renderReady();
    const meta = screen.getByText(/^Quill · Get something done/);
    const line = screen.getByText(finishByLine(FB));
    expect(meta.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    view.unmount();

    // A stay-on-top task that carries a date (it can't, but the page must not trust that) shows none.
    taskMock.mockResolvedValue(detail({ kind: 'stay-on-top', finishBy: FB }));
    await renderReady();
    expect(screen.queryByText(/Finish by/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a finish date' })).toBeNull();
  });

  it('a get-done task with no date offers Add a finish date', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done' }));
    await renderReady();
    expect(screen.getByRole('button', { name: 'Add a finish date' })).toBeInTheDocument();
  });

  it('a saved date shows at once, and the page reads the task again', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done' }));
    await renderReady();
    expect(taskMock).toHaveBeenCalledTimes(1);
    finishByMock.mockResolvedValueOnce({ finishBy: FB });
    // The re-read the save starts answers too, with the date the host now has.
    taskMock.mockResolvedValue(detail({ kind: 'get-done', finishBy: FB }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a finish date' }));
    fireEvent.change(screen.getByLabelText('Finish by'), { target: { value: '2026-11-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(finishByLine(FB))).toBeInTheDocument();
    expect(finishByMock).toHaveBeenCalledWith('a1', 't1', '2026-11-14');
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled());
    expect(screen.getByText(finishByLine(FB))).toBeInTheDocument();
  });
});

describe('TaskPage: a missed check-in (TASK-930)', () => {
  const MISSED = new Date(2026, 9, 22, 11, 2).toISOString();
  const LAST_UPDATE = '3 open. I’m answering #4411 and #4412 now.';
  const AUTO_PAUSED = 'Paused after 5 check-ins in a row didn’t leave an update.';

  function missed(over: Partial<TaskNoRecentUpdate> = {}): TaskNoRecentUpdate {
    return { inARow: 1, reason: 'no-report', at: MISSED, autoPaused: false, ...over };
  }

  function missedEntry(
    over: Partial<TaskDetail['updates'][number]> = {},
  ): TaskDetail['updates'][number] {
    return { firedAt: MISSED, status: 'ok', error: null, report: null, conversationId: null, ...over };
  }

  it('a check-in that left no report leads with No recent update, the reason and the fix, then the last update, muted', async () => {
    taskMock.mockResolvedValue(
      detail({ task: report({ status: 'on-track', ask: null }), noRecentUpdate: missed() }),
    );
    await renderReady();
    const latest = latestUpdate();
    const text = latest.textContent ?? '';
    const lastUpdate = `Last update at ${localTime(REPORTED)}: ${LAST_UPDATE}`;
    const positions = [
      'No recent update',
      'It checked in but didn’t say how it went.',
      'Press Check now to try again.',
      `Last check-in at ${localTime(MISSED)} · Next check at ${localTime(NEXT)}`,
      lastUpdate,
    ].map((line) => {
      expect(within(latest).getByText(line)).toBeInTheDocument();
      return text.indexOf(line);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The stale status is not drawn as if it were current.
    expect(within(latest).queryByText('On track')).toBeNull();
    expect(within(latest).getByText(lastUpdate)).toHaveClass('text-muted-foreground');
  });

  it('a needs-you report followed by one miss stays Needs you and keeps its ask, muted', async () => {
    taskMock.mockResolvedValue(detail({ noRecentUpdate: missed() }));
    await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByText('Needs you')).toBeInTheDocument();
    expect(within(latest).queryByText('No recent update')).toBeNull();
    const ask = within(latest).getByText(
      'Quill asks: Want me to draft a reply to #4410 for you to send?',
    );
    expect(ask).toHaveClass('text-muted-foreground');
    const text = latest.textContent ?? '';
    expect(text.indexOf(`Last update at ${localTime(REPORTED)}`)).toBeLessThan(text.indexOf('Quill asks:'));
  });

  it('an off-track report followed by one miss stays Off track', async () => {
    taskMock.mockResolvedValue(
      detail({ task: report({ status: 'off-track', ask: null }), noRecentUpdate: missed() }),
    );
    await renderReady();
    expect(within(latestUpdate()).getByText('Off track')).toBeInTheDocument();
    expect(within(latestUpdate()).queryByText('No recent update')).toBeNull();
  });

  it('three in a row read Needs you with the count', async () => {
    taskMock.mockResolvedValue(detail({ noRecentUpdate: missed({ inARow: 3 }) }));
    await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByText('Needs you')).toBeInTheDocument();
    expect(within(latest).queryByText('No recent update')).toBeNull();
    expect(
      within(latest).getByText(
        'Its last 3 check-ins didn’t leave an update. It checked in but didn’t say how it went.',
      ),
    ).toBeInTheDocument();
  });

  it('a task that never reported shows the miss without a last update', async () => {
    taskMock.mockResolvedValue(detail({ task: null, updates: [], noRecentUpdate: missed() }));
    await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByText('No recent update')).toBeInTheDocument();
    expect(within(latest).queryByText(/Last update/)).toBeNull();
  });

  it('See what it did opens the check-in that missed, not a newer one', async () => {
    const newer = new Date(2026, 9, 22, 11, 30).toISOString();
    taskMock.mockResolvedValue(
      detail({
        noRecentUpdate: missed(),
        updates: [
          missedEntry({ firedAt: newer, conversationId: 'c-newer' }),
          missedEntry({ conversationId: 'c-missed' }),
        ],
      }),
    );
    const { onNavigate } = await renderReady();
    const link = within(latestUpdate()).getByRole('link', { name: 'See what it did' });
    expect(link).toHaveAttribute('href', '/workspace/tasks/a1/t1/checkins/c-missed');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'task-checkin',
      agentId: 'a1',
      routineId: 't1',
      conversationId: 'c-missed',
    });
  });

  it('no See what it did when the check-in that missed has no conversation', async () => {
    taskMock.mockResolvedValue(
      detail({ noRecentUpdate: missed(), updates: [missedEntry({ conversationId: null })] }),
    );
    await renderReady();
    expect(within(latestUpdate()).queryByRole('link')).toBeNull();
  });

  it('a too-long brief points at the agent’s settings', async () => {
    taskMock.mockResolvedValue(detail({ noRecentUpdate: missed({ reason: 'brief-too-long' }) }));
    const { onNavigate } = await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByText('Its instructions are too long to load.')).toBeInTheDocument();
    expect(within(latest).getByText('Shorten “What to do” in Quill’s settings.')).toBeInTheDocument();
    const link = within(latest).getByRole('link', { name: 'Open Quill’s settings' });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'agent-settings',
      id: 'a1',
      section: 'routines',
    });
  });

  it('a too-long brief, for a viewer who can’t edit, says who needs to shorten it and has no settings link', async () => {
    taskMock.mockResolvedValue(
      detail({
        permissions: { fire: true, stop: true, edit: false },
        noRecentUpdate: missed({ reason: 'brief-too-long' }),
      }),
    );
    await renderReady();
    const latest = latestUpdate();
    expect(
      within(latest).getByText(
        'Someone who manages this agent’s tasks needs to shorten “What to do” in Quill’s settings.',
      ),
    ).toBeInTheDocument();
    expect(within(latest).queryByRole('link', { name: /settings/ })).toBeNull();
    expect(within(latest).queryByText(/Shorten/)).toBeNull();
  });

  it('only a too-long brief gets the settings link', async () => {
    taskMock.mockResolvedValue(detail({ noRecentUpdate: missed({ reason: 'failed' }) }));
    await renderReady();
    expect(within(latestUpdate()).queryByRole('link', { name: /settings/ })).toBeNull();
  });

  it('a paused task’s fix says to resume, never Check now', async () => {
    taskMock.mockResolvedValue(
      detail({ enabled: false, nextCheckAt: null, noRecentUpdate: missed() }),
    );
    await renderReady();
    const latest = latestUpdate();
    expect(
      within(latest).getByText('Press Resume, and it’ll try again at its next check-in.'),
    ).toBeInTheDocument();
    expect(within(latest).queryByText(/Press Check now/)).toBeNull();
    expect(within(latest).getByText(`Last check-in at ${localTime(MISSED)} · Paused`)).toBeInTheDocument();
  });

  it('a viewer who can’t press Check now is not told to', async () => {
    taskMock.mockResolvedValue(
      detail({
        permissions: { fire: false, stop: false, edit: true },
        noRecentUpdate: missed({ reason: 'failed' }),
      }),
    );
    await renderReady();
    const latest = latestUpdate();
    expect(within(latest).getByText('It’ll try again at its next check-in.')).toBeInTheDocument();
    expect(within(latest).queryByText(/Press Check now/)).toBeNull();
  });

  it('a viewer who can’t resume is not told to press Resume', async () => {
    taskMock.mockResolvedValue(
      detail({
        enabled: false,
        nextCheckAt: null,
        permissions: { fire: true, stop: true, edit: false },
        noRecentUpdate: missed({ reason: 'failed' }),
      }),
    );
    await renderReady();
    const latest = latestUpdate();
    expect(
      within(latest).getByText('Only someone who manages this agent’s tasks can resume it.'),
    ).toBeInTheDocument();
    expect(within(latest).queryByText(/Press Resume/)).toBeNull();
  });

  it('an auto-paused task says why it’s paused and how to resume', async () => {
    taskMock.mockResolvedValue(
      detail({
        enabled: false,
        nextCheckAt: null,
        noRecentUpdate: missed({ inARow: 5, autoPaused: true }),
      }),
    );
    await renderReady();
    const note = `${AUTO_PAUSED} Fix what’s below, then Resume.`;
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryByText(PAUSED_NOTE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check now' })).toHaveAccessibleDescription(note);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(
      within(latestUpdate()).getByText(
        'Its last 5 check-ins didn’t leave an update. It checked in but didn’t say how it went.',
      ),
    ).toBeInTheDocument();
  });

  it('without edit, an auto-paused task says only someone who manages the tasks can resume it', async () => {
    taskMock.mockResolvedValue(
      detail({
        enabled: false,
        nextCheckAt: null,
        permissions: { fire: true, stop: true, edit: false },
        noRecentUpdate: missed({ inARow: 5, autoPaused: true }),
      }),
    );
    await renderReady();
    const note = `${AUTO_PAUSED} Only someone who manages this agent’s tasks can resume it.`;
    expect(screen.getByText(note)).toBeInTheDocument();
    const resume = screen.getByRole('button', { name: 'Resume' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription(note);
  });

  it('a task a person paused after a miss keeps the ordinary paused note', async () => {
    taskMock.mockResolvedValue(
      detail({ enabled: false, nextCheckAt: null, noRecentUpdate: missed({ inARow: 2 }) }),
    );
    await renderReady();
    expect(screen.getByText(PAUSED_NOTE)).toBeInTheDocument();
  });

  it('Resume on an auto-paused task sends enabled true and reads the task again', async () => {
    taskMock
      .mockResolvedValueOnce(
        detail({
          enabled: false,
          revision: 'rev-9',
          nextCheckAt: null,
          noRecentUpdate: missed({ inARow: 5, autoPaused: true }),
        }),
      )
      .mockResolvedValue(detail({ revision: 'rev-10' }));
    updateMock.mockResolvedValue(ROUTINE);
    await renderReady();
    expect(screen.getByText(AUTO_PAUSED, { exact: false })).toBeInTheDocument();
    expect(within(latestUpdate()).getByText('Needs you')).toBeInTheDocument();
    expect(within(latestUpdate()).getByText(/didn’t leave an update/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByRole('button', { name: 'Pause' });
    expect(updateMock).toHaveBeenCalledWith({
      agentId: 'a1',
      routineId: 't1',
      expectedRevision: 'rev-9',
      requestId: expect.any(String),
      patch: { enabled: true },
    });
    expect(taskMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(AUTO_PAUSED, { exact: false })).toBeNull();
    expect(within(latestUpdate()).queryByText(/didn’t leave an update/)).toBeNull();
  });

  it('a miss time it can’t read shows no time, never Invalid Date', async () => {
    taskMock.mockResolvedValue(
      detail({
        noRecentUpdate: missed({ at: 'not a time' }),
        task: report({ reportedAt: 'also not a time' }),
      }),
    );
    await renderReady();
    const latest = latestUpdate();
    expect(latest.textContent).not.toContain('Invalid Date');
    expect(within(latest).getByText(`Next check at ${localTime(NEXT)}`)).toBeInTheDocument();
    expect(within(latest).getByText(`Last update: ${LAST_UPDATE}`)).toBeInTheDocument();
  });

  it('draws an agent-written last update as text', async () => {
    taskMock.mockResolvedValue(
      detail({
        noRecentUpdate: missed(),
        task: report({ update: '**bold** <img src=x onerror=alert(1)>' }),
      }),
    );
    const { container } = await renderReady();
    expect(container.querySelector('img')).toBeNull();
    expect(
      within(latestUpdate()).getByText(
        `Last update at ${localTime(REPORTED)}: **bold** <img src=x onerror=alert(1)>`,
      ),
    ).toBeInTheDocument();
  });

  it('an unreadable last update says so', async () => {
    taskMock.mockResolvedValue(detail({ noRecentUpdate: missed(), task: report({ update: null }) }));
    await renderReady();
    expect(
      within(latestUpdate()).getByText(
        `Last update at ${localTime(REPORTED)}: It left an update we can’t show.`,
      ),
    ).toBeInTheDocument();
  });
});

describe('TaskPage: replies and checking in now (TASK-931)', () => {
  const BOX = 'Reply to Quill about this task';
  const FINISHED = 'Quill finished checking in.';
  const DIDNT_FINISH = 'The check-in didn’t finish. The reason is under Updates.';
  const STILL = 'Still checking in. Its update will be under Updates when it’s done.';

  /** A check-in that landed after the press: a new time and its own conversation. */
  function landed(over: Partial<TaskDetail['updates'][number]> = {}): TaskDetail {
    const base = detail();
    return detail({
      updates: [
        {
          firedAt: new Date(Date.now()).toISOString(),
          status: 'ok',
          error: null,
          report: { status: 'on-track', update: 'All answered.', reading: null },
          conversationId: 'c-new',
          ...over,
        },
        ...base.updates,
      ],
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Check now, answered ok, and the re-read after it done. */
  async function checkNow() {
    fireNowMock.mockResolvedValue({ status: 'ok' });
    const check = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    await settled(check, 2);
    return check;
  }

  async function sendReply(text: string) {
    const box = screen.getByRole('textbox', { name: BOX });
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));
  }

  it('the reply box sits under Updates', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    const updates = screen.getByRole('region', { name: 'Updates' });
    const box = screen.getByRole('textbox', { name: BOX });
    expect(updates.contains(box)).toBe(false);
    expect(updates.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByText('Quill reads your replies every time it checks in. Sending one starts a check-in now.'),
    ).toBeInTheDocument();
  });

  it('a paused task’s box says it’ll be read once resumed', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null }));
    await renderReady();
    expect(
      screen.getByText('It’s paused, so Quill will read this once you resume it.'),
    ).toBeInTheDocument();
  });

  it('an owner who can’t manage the agent’s tasks isn’t promised a check-in', async () => {
    taskMock.mockResolvedValue(detail({ permissions: { fire: false, stop: false, edit: false } }));
    await renderReady();
    expect(screen.getByText('Quill reads your replies every time it checks in.')).toBeInTheDocument();
    expect(screen.queryByText(/Sending one starts a check-in now/)).toBeNull();
  });

  it('Reply on the latest card focuses the box', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    const reply = within(latestUpdate()).getByRole('button', { name: 'Reply' });
    fireEvent.click(reply);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: BOX }));
  });

  it('no Reply when the agent asks nothing', async () => {
    taskMock.mockResolvedValue(detail({ task: report({ ask: null }) }));
    await renderReady();
    expect(within(latestUpdate()).queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('the missed check-in card’s muted ask has Reply too', async () => {
    taskMock.mockResolvedValue(
      detail({
        noRecentUpdate: {
          inARow: 1,
          reason: 'no-report',
          at: new Date(2026, 9, 22, 11, 2).toISOString(),
          autoPaused: false,
        },
      }),
    );
    await renderReady();
    const latest = latestUpdate();
    expect(
      within(latest).getByText('Quill asks: Want me to draft a reply to #4410 for you to send?'),
    ).toHaveClass('text-muted-foreground');
    fireEvent.click(within(latest).getByRole('button', { name: 'Reply' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: BOX }));
  });

  it('a reply that started a check-in reads the task again at once and shows Checking in now…, hidden from the screen reader because the box said it', async () => {
    taskMock.mockResolvedValue(detail());
    replyMock.mockResolvedValue({ checkIn: 'started' });
    await renderReady();
    await sendReply('Refunds under $100 are fine.');
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    const line = await within(pageStatus()).findByText(CHECKING_IN);
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Sent. Quill started checking in.')).toBeInTheDocument();
  });

  it('a reply answering replayed starts the poll too: Checking in now…, and a re-read at 10 seconds', async () => {
    taskMock.mockResolvedValue(detail());
    replyMock.mockResolvedValue({ checkIn: 'replayed' });
    await renderReady();
    await sendReply('Refunds under $100 are fine.');
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    expect(await within(pageStatus()).findByText(CHECKING_IN)).toBeInTheDocument();
    await advance(10_000);
    expect(taskMock).toHaveBeenCalledTimes(3);
  });

  it('a reply answering not-allowed starts no poll: no Checking in now…, no re-read at 10 seconds', async () => {
    taskMock.mockResolvedValue(detail({ permissions: { fire: false, stop: false, edit: false } }));
    replyMock.mockResolvedValue({ checkIn: 'not-allowed' });
    await renderReady();
    await sendReply('Refunds under $100 are fine.');
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Sent. Quill will read it at its next check-in.')).toBeInTheDocument();
    expect(screen.queryByText(CHECKING_IN)).toBeNull();
    await advance(10_000);
    expect(taskMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(CHECKING_IN)).toBeNull();
  });

  it('after Check now the line is announced', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    await checkNow();
    const line = within(pageStatus()).getByText(CHECKING_IN);
    expect(line).not.toHaveAttribute('aria-hidden');
    expect(line.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('a reply to a paused task reads the task again and doesn’t say it’s checking in', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null }));
    replyMock.mockResolvedValue({ checkIn: 'paused' });
    await renderReady();
    await sendReply('Back on Monday.');
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    expect(pageStatus()).toBeEmptyDOMElement();
    await advance(30_000);
    expect(taskMock).toHaveBeenCalledTimes(2);
  });

  it('after Check now the page reads the task every 10 seconds until its update arrives, then says it finished', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail())
      .mockImplementation(async () => landed());
    await renderReady();
    await checkNow();
    expect(within(pageStatus()).getByText(CHECKING_IN)).toBeInTheDocument();

    await advance(10_000);
    expect(taskMock).toHaveBeenCalledTimes(3);
    expect(within(pageStatus()).getByText(CHECKING_IN)).toBeInTheDocument();
    await advance(10_000);
    expect(taskMock).toHaveBeenCalledTimes(4);
    expect(pageStatus()).toHaveTextContent(FINISHED);
    await advance(30_000);
    expect(taskMock).toHaveBeenCalledTimes(4);
    expect(pageStatus()).toHaveTextContent(FINISHED);
  });

  it('the 10-second re-reads leave Check now and Pause pressable and raise no refresh alert, even when one fails', async () => {
    const pending = deferred<TaskDetail>();
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail())
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new WorkspaceApiError(TASK_PATH, 503))
      .mockResolvedValue(detail());
    await renderReady();
    const check = await checkNow();
    const pause = screen.getByRole('button', { name: 'Pause' });

    await advance(10_000);
    expect(taskMock).toHaveBeenCalledTimes(3);
    expect(check).toBeEnabled();
    expect(pause).toBeEnabled();
    await act(async () => pending.resolve(detail()));

    await advance(10_000);
    expect(taskMock).toHaveBeenCalledTimes(4);
    expect(check).toBeEnabled();
    expect(pause).toBeEnabled();
    expect(
      screen.queryByText('We couldn’t refresh this task just now, so what you see may be out of date.'),
    ).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(pageStatus()).getByText(CHECKING_IN)).toBeInTheDocument();
  });

  it('a check-in that didn’t finish says so when it arrives', async () => {
    taskMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail())
      .mockImplementation(async () =>
        landed({ status: 'error', error: 'It couldn’t start.', report: null }),
      );
    await renderReady();
    await checkNow();
    await advance(10_000);
    expect(pageStatus()).toHaveTextContent(DIDNT_FINISH);
    expect(pageStatus()).not.toHaveTextContent(FINISHED);
  });

  it('after five minutes it stops reading and says it’s still checking in', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    await checkNow();
    // The real clock runs too (`shouldAdvanceTime`), so the edge itself is
    // pinned in `use-task-poll.test.ts`; here, either side of it.
    await advance(290_000);
    expect(within(pageStatus()).getByText(CHECKING_IN)).toBeInTheDocument();
    await advance(10_000);
    expect(pageStatus()).toHaveTextContent(STILL);
    const reads = taskMock.mock.calls.length;
    await advance(60_000);
    expect(taskMock).toHaveBeenCalledTimes(reads);
  });
});

describe('TaskPage: the agent’s reading (TASK-952)', () => {
  const OPEN_3 = { label: 'Open tickets', value: 3 };
  const SAID = '3 open. I’m answering #4411 and #4412 now.';

  function readingBlock(): HTMLElement {
    return screen.getByRole('region', { name: 'Quill’s reading' });
  }

  it('draws Quill’s reading after the latest update and before the brief', async () => {
    taskMock.mockResolvedValue(detail({ task: report({ reading: OPEN_3 }) }));
    await renderReady();
    const block = readingBlock();
    expect(within(block).getByText('Open tickets')).toBeInTheDocument();
    expect(within(block).getByText('3')).toBeInTheDocument();
    const latest = latestUpdate();
    expect(latest).not.toContainElement(block);
    expect(latest.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const brief = screen.getByRole('region', { name: 'About this task' });
    expect(block.compareDocumentPosition(brief) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws no reading when the latest report has none', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    expect(screen.queryByRole('region', { name: 'Quill’s reading' })).toBeNull();
  });

  it('draws the trend from the check-ins under Updates', async () => {
    taskMock.mockResolvedValue(
      detail({
        task: report({ reading: OPEN_3 }),
        updates: [
          {
            firedAt: REPORTED,
            status: 'ok',
            error: null,
            report: { status: 'needs-you', update: SAID, reading: OPEN_3 },
            conversationId: null,
          },
          {
            firedAt: new Date(2026, 9, 22, 9, 2).toISOString(),
            status: 'ok',
            error: null,
            report: { status: 'on-track', update: '5 open.', reading: { label: 'Open tickets', value: 5 } },
            conversationId: null,
          },
        ],
      }),
    );
    await renderReady();
    const block = readingBlock();
    expect(within(block).getByText('Earlier: 5')).toBeInTheDocument();
    expect(block.querySelector('svg')).not.toBeNull();
  });

  it('keeps the reading under a missed check-in, whose card still shows the last update', async () => {
    taskMock.mockResolvedValue(
      detail({
        task: report({ status: 'on-track', ask: null, reading: OPEN_3 }),
        noRecentUpdate: {
          inARow: 1,
          reason: 'no-report',
          at: new Date(2026, 9, 22, 11, 2).toISOString(),
          autoPaused: false,
        },
      }),
    );
    await renderReady();
    expect(within(latestUpdate()).getByText('No recent update')).toBeInTheDocument();
    expect(within(readingBlock()).getByText('Open tickets')).toBeInTheDocument();
  });
});
