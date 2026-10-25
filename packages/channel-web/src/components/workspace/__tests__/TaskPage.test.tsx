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
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { routineApi, RoutineApiError, type Routine } from '@/lib/routines';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { finishByLine } from '@/lib/task-finish-by';
import { localTime } from '@/lib/workspace-time';
import type { TaskDetail, TaskDetailReport, TaskNoRecentUpdate } from '@/lib/workspace-types';
import { MARK_DONE_NOT_ALLOWED } from '../TaskMarkDone';
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
      completeTask: vi.fn(),
      reopenTask: vi.fn(),
      duplicateTask: vi.fn(),
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
const completeMock = vi.mocked(workspaceApi.completeTask);
const reopenMock = vi.mocked(workspaceApi.reopenTask);
const duplicateMock = vi.mocked(workspaceApi.duplicateTask);
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
const PAUSED_NO_EDIT_NOTE =
  'Paused. Only someone who manages this agent’s tasks can resume or copy it.';
const NO_MANAGE_NOTE =
  'You can’t start or pause this task’s check-ins, or copy the task, because you no longer manage this agent’s tasks.';

function report(over: Partial<TaskDetailReport> = {}): TaskDetailReport {
  return {
    status: 'needs-you',
    update: '3 open. I’m answering #4411 and #4412 now.',
    ask: 'Want me to draft a reply to #4410 for you to send?',
    agentNotes: 'Ticket 4410 is from an enterprise customer.\nLeave it for Sam.',
    reading: null,
    doneClaimed: false,
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
    doneAt: null,
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

function renderPage(over: { justCopied?: boolean } = {}) {
  const onNavigate = vi.fn<(route: WorkspaceRoute) => void>();
  const onDuplicated = vi.fn<(routineId: string) => void>();
  const view = render(
    <TaskPage
      agentId="a1"
      routineId="t1"
      leading={<button type="button">Open navigation</button>}
      onNavigate={onNavigate}
      onDuplicated={onDuplicated}
      justCopied={over.justCopied ?? false}
    />,
  );
  return { ...view, onNavigate, onDuplicated };
}

/** Render, and wait for the task to be on screen. */
async function renderReady(over: { justCopied?: boolean } = {}) {
  const view = renderPage(over);
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
  completeMock.mockReset();
  reopenMock.mockReset();
  duplicateMock.mockReset();
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
      buttons: ['Check now', 'Pause', 'More actions'],
    },
    {
      what: 'a paused task',
      over: { enabled: false, nextCheckAt: null },
      note: PAUSED_NO_EDIT_NOTE,
      buttons: ['Check now', 'Resume', 'More actions'],
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

  it('shows the saved date before the re-read settles, and keeps it when the re-read fails (the page applies the answer)', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done' }));
    await renderReady();
    finishByMock.mockResolvedValueOnce({ finishBy: FB });
    // The re-read the save starts hangs until the test says so.
    const reread = deferred<TaskDetail>();
    taskMock.mockReturnValueOnce(reread.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Add a finish date' }));
    fireEvent.change(screen.getByLabelText('Finish by'), { target: { value: '2026-11-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // On screen from the PUT's own answer, with the re-read still in flight.
    expect(await screen.findByText(finishByLine(FB))).toBeInTheDocument();
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    // The re-read fails; the date the host just confirmed stays.
    await act(async () => {
      reread.reject(new WorkspaceApiError(TASK_PATH, 503));
      await Promise.resolve();
    });
    await waitFor(() => expect(warn).toHaveBeenCalled());
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
    const note = `${AUTO_PAUSED} Only someone who manages this agent’s tasks can resume or copy it.`;
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

describe('TaskPage: finishing a task (TASK-950)', () => {
  const STEPS = [
    { id: 's1', text: 'Export every article', done: true, byAgent: true },
    { id: 's2', text: 'Check the redirects', done: false, byAgent: false },
  ];
  const ALL_TICKED = [STEPS[0]!];
  const DONE_AT = new Date(2026, 9, 22, 11, 30).toISOString();
  const NOT_YET_BOX = 'What’s left for Quill to do?';
  const UNCONFIRMED_DONE =
    'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.';
  const REPLY_BOX = 'Reply to Quill about this task';

  /** A get-done task whose agent says it thinks it's finished. */
  function claimed(over: Partial<TaskDetail> = {}): TaskDetail {
    return detail({
      kind: 'get-done',
      steps: ALL_TICKED,
      task: report({ status: 'needs-you', ask: null, doneClaimed: true }),
      ...over,
    });
  }

  function doneTask(over: Partial<TaskDetail> = {}): TaskDetail {
    return detail({
      kind: 'get-done',
      enabled: false,
      nextCheckAt: null,
      doneAt: DONE_AT,
      steps: STEPS,
      task: report({ ask: null, doneClaimed: false }),
      ...over,
    });
  }

  const after = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

  it('a claimed task leads its latest update with the claim, and Mark done is the page’s one primary action', async () => {
    taskMock.mockResolvedValue(claimed());
    await renderReady();
    const latest = latestUpdate();
    const claim = within(latest).getByText('Quill thinks this is done.');
    expect(after(claim, within(latest).getByText('3 open. I’m answering #4411 and #4412 now.'))).toBeTruthy();
    const primary = screen
      .getAllByRole('button')
      .filter((b) => b.className.includes('bg-action'))
      .map((b) => b.textContent);
    expect(primary).toEqual(['Mark done']);
    expect(screen.getByRole('button', { name: 'Check now' })).not.toHaveClass('bg-action');
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeInTheDocument();
  });

  it('a claimed, paused task has Resume as an outline button too', async () => {
    taskMock.mockResolvedValue(claimed({ enabled: false, nextCheckAt: null }));
    await renderReady();
    expect(screen.getByRole('button', { name: 'Resume' })).not.toHaveClass('bg-action');
    expect(within(latestUpdate()).getByRole('button', { name: 'Mark done' })).toHaveClass('bg-action');
  });

  it('a claim that came with an ask keeps the ask and its Reply', async () => {
    taskMock.mockResolvedValue(claimed({ task: report({ doneClaimed: true }) }));
    await renderReady();
    const latest = latestUpdate();
    expect(
      within(latest).getByText('Quill asks: Want me to draft a reply to #4410 for you to send?'),
    ).toBeInTheDocument();
    expect(within(latest).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(within(latest).getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
  });

  it('a claim over a missed check-in says Quill said so, and still offers Mark done and Not yet', async () => {
    taskMock.mockResolvedValue(
      claimed({
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
    const said = within(latest).getByText('Quill said it thinks this is done.');
    expect(after(said, within(latest).getByText(/^Last update/))).toBeTruthy();
    expect(within(latest).getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
    expect(within(latest).getByRole('button', { name: 'Not yet' })).toBeInTheDocument();
  });

  it('Mark done finishes on the first press with every step ticked, and reads the task again', async () => {
    taskMock.mockResolvedValueOnce(claimed());
    await renderReady();
    completeMock.mockResolvedValue({ done: true });
    taskMock.mockResolvedValue(doneTask({ steps: ALL_TICKED }));
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(1));
    expect(completeMock).toHaveBeenCalledWith('a1', 't1', { requestId: expect.any(String) });
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Done · You marked it done/)).toBeInTheDocument();
  });

  it('Mark done finishes on the first press with no steps at all', async () => {
    taskMock.mockResolvedValueOnce(claimed({ steps: [] }));
    await renderReady();
    completeMock.mockResolvedValue({ done: true });
    taskMock.mockResolvedValue(doneTask({ steps: [] }));
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(1));
  });

  it.each([
    [[STEPS[1]!], '1 step isn’t ticked. It’ll stay on the task as it is.'],
    [
      [STEPS[1]!, { id: 's3', text: 'Tell Sam', done: false, byAgent: false }],
      '2 steps aren’t ticked. They’ll stay on the task as they are.',
    ],
  ])('Mark done asks first with unticked steps (%#)', async (steps, line) => {
    taskMock.mockResolvedValue(claimed({ steps }));
    await renderReady();
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(completeMock).not.toHaveBeenCalled();
    const anyway = screen.getByRole('button', { name: 'Mark done anyway' });
    expect(anyway).toHaveClass('bg-action');
    expect(document.activeElement).toBe(anyway);
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(anyway);
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(1));
  });

  it('Cancel closes the question and finishes nothing', async () => {
    taskMock.mockResolvedValue(claimed({ steps: [STEPS[1]!] }));
    await renderReady();
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/isn’t ticked/)).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
    expect(within(latestUpdate()).getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
  });

  it.each<[string, () => TaskDetail, () => HTMLElement]>([
    ['the claim card', () => claimed({ steps: [STEPS[1]!] }), () => latestUpdate()],
    ['the steps footer', () => detail({ kind: 'get-done', steps: STEPS }), () => document.body],
  ])('Cancel in %s puts focus back on Mark done', async (_, task, scope) => {
    taskMock.mockResolvedValue(task());
    await renderReady();
    fireEvent.click(within(scope()).getByRole('button', { name: 'Mark done' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    act(() => cancel.focus());
    fireEvent.click(cancel);
    expect(document.activeElement).toBe(within(scope()).getByRole('button', { name: 'Mark done' }));
  });

  it('a Mark done whose re-read failed doesn’t move focus when the task shows Done later', async () => {
    taskMock.mockResolvedValueOnce(claimed());
    await renderReady();
    completeMock.mockResolvedValue({ done: true });
    taskMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks/a1/t1', 500));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    await screen.findByText('We couldn’t refresh this task just now, so what you see may be out of date.');
    // Something else reads the task later, and by then it shows Done.
    fireNowMock.mockResolvedValue({ status: 'ok' });
    taskMock.mockResolvedValue(doneTask({ steps: ALL_TICKED }));
    const check = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    const line = await screen.findByText(/^Done · You marked it done/);
    expect(document.activeElement).not.toBe(line.closest('[tabindex="-1"]'));
  });

  it('once the task shows as Done, focus goes to the Done line', async () => {
    taskMock.mockResolvedValueOnce(claimed());
    await renderReady();
    completeMock.mockResolvedValue({ done: true });
    taskMock.mockResolvedValue(doneTask({ steps: ALL_TICKED }));
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    const line = await screen.findByText(/^Done · You marked it done/);
    await waitFor(() => expect(document.activeElement).toBe(line.closest('[tabindex="-1"]')));
  });

  it('a Mark done nobody could confirm says so, and focus comes back to the button', async () => {
    taskMock.mockResolvedValue(claimed());
    await renderReady();
    const answer = deferred<{ done: true }>();
    completeMock.mockReturnValue(answer.promise);
    const button = within(latestUpdate()).getByRole('button', { name: 'Mark done' });
    act(() => button.focus());
    fireEvent.click(button);
    expect(button).toBeDisabled();
    dropFocusOnBody();
    await act(async () => answer.reject(new WorkspaceApiError('/tasks/a1/t1/complete', 503)));
    expect(
      await screen.findByText(
        'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    expect(document.activeElement).toBe(button);
  });

  it('a failed Mark done anyway puts focus back inside the question', async () => {
    taskMock.mockResolvedValue(claimed({ steps: [STEPS[1]!] }));
    await renderReady();
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    completeMock.mockRejectedValue(new WorkspaceApiError('/tasks/a1/t1/complete', 500));
    const anyway = screen.getByRole('button', { name: 'Mark done anyway' });
    act(() => anyway.focus());
    fireEvent.click(anyway);
    await screen.findByText('We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.');
    await waitFor(() => expect(anyway).toBeEnabled());
    expect(document.activeElement).toBe(anyway);
    // The question stays open, and a retry carries the same request.
    fireEvent.click(anyway);
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2]).toEqual(completeMock.mock.calls[0]![2]);
  });

  /** Presses whichever Mark done is on screen (never both are), and Mark done anyway if it asks. */
  async function pressMarkDone() {
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    const anyway = screen.queryByRole('button', { name: 'Mark done anyway' });
    if (anyway !== null) fireEvent.click(anyway);
  }

  /** Not yet on a claim the host had already seen Done and reopened: the re-read shows it running, unclaimed. */
  async function notYetOnTheStaleClaim(start: TaskDetail) {
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: start.steps }));
    const notYet = screen.getByRole('button', { name: 'Not yet' });
    fireEvent.click(notYet);
    fireEvent.change(screen.getByRole('textbox', { name: NOT_YET_BOX }), {
      target: { value: 'One redirect is still broken.' },
    });
    const inPlace = document.getElementById(notYet.getAttribute('aria-controls')!)!;
    fireEvent.click(within(inPlace).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull());
  }

  /** Something else reads the task, Done by then; Reopen, and the re-read shows it running, unclaimed. */
  async function doneThenReopen(start: TaskDetail) {
    fireNowMock.mockResolvedValue({ status: 'ok' });
    taskMock.mockResolvedValue(doneTask({ steps: start.steps }));
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: start.steps }));
    fireEvent.change(screen.getByRole('textbox', { name: NOT_YET_BOX }), {
      target: { value: 'One redirect is still broken.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull());
  }

  /**
   * Something else reads the task, and it shows a newer claim: between the two reads the claim
   * was taken back (Not yet in another tab) and the agent claimed again. Claimed both times, but
   * not the same claim.
   */
  async function newerClaim(start: TaskDetail) {
    fireNowMock.mockResolvedValue({ status: 'ok' });
    taskMock.mockResolvedValue({
      ...start,
      task: report({
        ask: null,
        doneClaimed: true,
        update: 'Every redirect works now.',
        reportedAt: new Date(2026, 9, 22, 11, 45).toISOString(),
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await within(latestUpdate()).findByText('Every redirect works now.');
  }

  // The press nobody confirmed may have finished the task. Once the page shows the task in another
  // state, a press answers that state: a fresh request, not a replay of the old one's receipt, and
  // nothing of the old press (its alert, or its question, whose Mark done anyway takes focus when it
  // opens) comes back with it.
  it.each<[string, () => TaskDetail, (start: TaskDetail) => Promise<void>]>([
    ['Not yet on the stale claim', () => claimed(), notYetOnTheStaleClaim],
    ['a later read showing it Done, then Reopen', () => claimed(), doneThenReopen],
    [
      'a later read showing it Done, then Reopen, with a step not ticked',
      () => claimed({ steps: STEPS }),
      doneThenReopen,
    ],
    // Never claimed, so only when it was marked done changes between the two presses.
    [
      'a later read showing it Done, then Reopen, never claimed',
      () => claimed({ task: report({ ask: null, doneClaimed: false }) }),
      doneThenReopen,
    ],
    ['a later read showing a newer claim', () => claimed(), newerClaim],
  ])('after an unconfirmed Mark done and %s, the next press is a new one', async (_, start, between) => {
    const first = start();
    taskMock.mockResolvedValue(first);
    await renderReady();
    completeMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks/a1/t1/complete', 502));
    await pressMarkDone();
    await screen.findByText(UNCONFIRMED_DONE);
    await between(first);
    // Mark done carries none of the old press: no alert, no question, and a new request.
    expect(screen.queryByText(UNCONFIRMED_DONE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
    completeMock.mockResolvedValue({ done: true });
    await pressMarkDone();
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2].requestId).not.toBe(completeMock.mock.calls[0]![2].requestId);
  });

  it('after an unconfirmed Mark done, a later read showing the same claim keeps the press', async () => {
    taskMock.mockResolvedValue(claimed());
    await renderReady();
    completeMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks/a1/t1/complete', 502));
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    await screen.findByText(UNCONFIRMED_DONE);
    // Something else reads the task again, and nothing about it changed: a retry is the same request.
    fireNowMock.mockResolvedValue({ status: 'ok' });
    taskMock.mockResolvedValue(claimed());
    const check = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    await settled(check, 2);
    expect(screen.getByText(UNCONFIRMED_DONE)).toBeInTheDocument();
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2]).toEqual(completeMock.mock.calls[0]![2]);
  });

  it('an unconfirmed Mark done anyway leaves nothing behind when Not yet takes the claim back', async () => {
    taskMock.mockResolvedValue(claimed({ steps: STEPS }));
    await renderReady();
    // The box was opened first, so its Send is still in reach while the question is up.
    const notYet = screen.getByRole('button', { name: 'Not yet' });
    fireEvent.click(notYet);
    const inPlace = document.getElementById(notYet.getAttribute('aria-controls')!)!;
    const box = within(inPlace).getByRole('textbox', { name: NOT_YET_BOX });
    fireEvent.change(box, { target: { value: 'One redirect is still broken.' } });
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    completeMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks/a1/t1/complete', 502));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done anyway' }));
    await screen.findByText(UNCONFIRMED_DONE);

    // Everything the claim going adds to the page, commit by commit.
    const added: string[] = [];
    const record = (records: MutationRecord[]) => {
      for (const r of records) for (const node of r.addedNodes) added.push(node.textContent ?? '');
    };
    const watch = new MutationObserver(record);
    watch.observe(document.body, { childList: true, subtree: true });
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS }));
    act(() => box.focus());
    fireEvent.click(within(inPlace).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled());
    record(watch.takeRecords());
    watch.disconnect();

    // The old press's alert and question never reach the steps' footer, not for one commit, so
    // nothing takes focus from the box the person is in.
    expect(added.filter((t) => t.includes(UNCONFIRMED_DONE) || t.includes('Mark done anyway'))).toEqual([]);
    expect(document.activeElement).toBe(box);
    expect(screen.getByText('Sent. Quill is checking in now.')).toBeInTheDocument();
  });

  it('a refused Mark done says why in the page’s words', async () => {
    taskMock.mockResolvedValue(claimed());
    await renderReady();
    completeMock.mockRejectedValue(new WorkspaceApiError('/tasks/a1/t1/complete', 403));
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(MARK_DONE_NOT_ALLOWED);
  });

  it('Not yet opens the box in place: what’s left, sent as a reopen, and the line stays after the claim goes', async () => {
    taskMock.mockResolvedValueOnce(claimed());
    await renderReady();
    const notYet = screen.getByRole('button', { name: 'Not yet' });
    expect(notYet).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(notYet);
    const box = screen.getByRole('textbox', { name: NOT_YET_BOX });
    expect(notYet).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(box);
    expect(screen.getByText('Quill reads this, and sending it starts a check-in now.')).toBeInTheDocument();
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: ALL_TICKED }));
    fireEvent.change(box, { target: { value: 'Still two tickets left.' } });
    // The bottom reply box has a Send too; this one is inside the in-place box.
    const inPlace = document.getElementById(notYet.getAttribute('aria-controls')!)!;
    fireEvent.click(within(inPlace).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(reopenMock).toHaveBeenCalledWith('a1', 't1', {
        text: 'Still two tickets left.',
        requestId: expect.any(String),
      }),
    );
    expect(replyMock).not.toHaveBeenCalled();
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull());
    expect(screen.getByText('Sent. Quill is checking in now.')).toBeInTheDocument();
  });

  it('a new claim after a sent Not yet finds the box closed and empty, its old line gone', async () => {
    taskMock.mockResolvedValueOnce(claimed());
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    const notYet = screen.getByRole('button', { name: 'Not yet' });
    const inPlace = document.getElementById(notYet.getAttribute('aria-controls')!)!;
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    taskMock.mockResolvedValueOnce(detail({ kind: 'get-done', steps: ALL_TICKED }));
    fireEvent.change(within(inPlace).getByRole('textbox', { name: NOT_YET_BOX }), {
      target: { value: 'Still two tickets left.' },
    });
    fireEvent.click(within(inPlace).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull());
    // While the claim is gone, its answer is still on screen.
    expect(within(inPlace).getByText('Sent. Quill is checking in now.')).toBeInTheDocument();

    // The agent claims again; the next read shows it.
    fireNowMock.mockResolvedValue({ status: 'ok' });
    taskMock.mockResolvedValue(claimed());
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    const again = await screen.findByRole('button', { name: 'Not yet' });
    expect(again).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Sent. Quill is checking in now.')).toBeNull();
    fireEvent.click(again);
    expect(again).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: NOT_YET_BOX })).toHaveValue('');
  });

  it('a Not yet box left open closes once the task is marked done', async () => {
    taskMock.mockResolvedValueOnce(claimed());
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.getByRole('textbox', { name: NOT_YET_BOX })).toBeVisible();
    completeMock.mockResolvedValue({ done: true });
    taskMock.mockResolvedValue(doneTask({ steps: ALL_TICKED }));
    fireEvent.click(within(latestUpdate()).getByRole('button', { name: 'Mark done' }));
    const reopen = await screen.findByRole('button', { name: 'Reopen' });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: NOT_YET_BOX })).toBeNull();
  });

  it('pressing Not yet again closes the box, and it keeps what was typed', async () => {
    taskMock.mockResolvedValue(claimed());
    await renderReady();
    const notYet = screen.getByRole('button', { name: 'Not yet' });
    fireEvent.click(notYet);
    fireEvent.change(screen.getByRole('textbox', { name: NOT_YET_BOX }), { target: { value: 'Hm' } });
    fireEvent.click(notYet);
    expect(notYet).toHaveAttribute('aria-expanded', 'false');
    const hidden = document.getElementById(notYet.getAttribute('aria-controls')!)!;
    expect(hidden).toHaveAttribute('hidden');
    fireEvent.click(notYet);
    expect(hidden).not.toHaveAttribute('hidden');
    expect(screen.getByRole('textbox', { name: NOT_YET_BOX })).toHaveValue('Hm');
  });

  it('without edit, Mark done is disabled and says why; Not yet still works', async () => {
    taskMock.mockResolvedValue(claimed({ permissions: { fire: false, stop: false, edit: false } }));
    await renderReady();
    const mark = within(latestUpdate()).getByRole('button', { name: 'Mark done' });
    expect(mark).toBeDisabled();
    const why = document.getElementById(mark.getAttribute('aria-describedby')!)!;
    expect(why).toHaveTextContent(MARK_DONE_NOT_ALLOWED);
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeEnabled();
  });

  it('a running get-done task offers Mark done under its steps; a paused one with the first sentence only', async () => {
    taskMock.mockResolvedValueOnce(detail({ kind: 'get-done', steps: STEPS }));
    const { unmount } = await renderReady();
    const mark = screen.getByRole('button', { name: 'Mark done' });
    expect(mark).not.toHaveClass('bg-action');
    const text = document.getElementById(mark.getAttribute('aria-describedby')!)!;
    expect(text).toHaveTextContent(
      'Only you can mark this task done. When Quill thinks it’s finished, it’ll ask you here and on Today.',
    );
    expect(after(screen.getByRole('heading', { level: 2, name: /^Steps/ }), mark)).toBeTruthy();
    expect(after(mark, screen.getByRole('region', { name: 'About this task' }))).toBeTruthy();
    unmount();
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS, enabled: false, nextCheckAt: null }));
    await renderReady();
    expect(screen.getByText('Only you can mark this task done.')).toBeInTheDocument();
    expect(screen.queryByText(/it’ll ask you here/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled();
  });

  it('under the steps, without edit, Mark done is disabled and says only why', async () => {
    taskMock.mockResolvedValue(
      detail({ kind: 'get-done', steps: STEPS, permissions: { fire: false, stop: false, edit: false } }),
    );
    await renderReady();
    const mark = screen.getByRole('button', { name: 'Mark done' });
    expect(mark).toBeDisabled();
    expect(document.getElementById(mark.getAttribute('aria-describedby')!)).toHaveTextContent(
      MARK_DONE_NOT_ALLOWED,
    );
    expect(screen.queryByText(/Only you can mark/)).toBeNull();
  });

  it('a stay-on-top task has no Mark done', async () => {
    taskMock.mockResolvedValue(detail());
    await renderReady();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
  });

  it('ticking the last step while Mark done asks closes the question, and the next press finishes', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS }));
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(screen.getByText('1 step isn’t ticked. It’ll stay on the task as it is.')).toBeInTheDocument();
    // The step's box is right above the question (TASK-949); the answer is the list, now all ticked.
    stepsMock.mockResolvedValue({ steps: STEPS.map((step) => ({ ...step, done: true })), skipped: 0 });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check the redirects' }));
    await waitFor(() => expect(screen.queryByText(/ticked/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
  });

  it('the footer’s Mark done asks first with unticked steps, outline', async () => {
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS }));
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(screen.getByText('1 step isn’t ticked. It’ll stay on the task as it is.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark done anyway' })).not.toHaveClass('bg-action');
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('a Done task: Reopen only, the Done line, its steps as they are, no reply box', async () => {
    taskMock.mockResolvedValue(doneTask());
    await renderReady();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeEnabled();
    expect(
      within(latestUpdate()).getByText(`Done · You marked it done at ${localTime(DONE_AT)}.`),
    ).toBeInTheDocument();
    expect(
      within(latestUpdate()).getByText(
        `Last update at ${localTime(REPORTED)}: 3 open. I’m answering #4411 and #4412 now.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Not done:')).toBeInTheDocument();
    // The steps are its record (TASK-949's controls go): no box to tick, no options, nothing to add.
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Step options' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a step' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: REPLY_BOX })).toBeNull();
    expect(screen.queryByText(/Only someone who manages/)).toBeNull();
  });

  it('a step change refused because the task was marked done elsewhere reads it again, and shows it Done', async () => {
    taskMock.mockResolvedValueOnce(detail({ kind: 'get-done', steps: STEPS }));
    await renderReady();
    // Marked done on Today meanwhile: the host refuses the tick, which the route answers as the page's own 404.
    stepsMock.mockRejectedValue(new WorkspaceApiError('/tasks/a1/t1/steps', 404));
    taskMock.mockResolvedValue(doneTask());
    const tick = screen.getByRole('checkbox', { name: 'Check the redirects' });
    act(() => tick.focus());
    fireEvent.click(tick);
    const line = await screen.findByText(/^Done · You marked it done/);
    expect(taskMock).toHaveBeenCalledTimes(2);
    // The refusal's line went with the controls: the steps show as the record they now are, and say the tick didn't land.
    expect(screen.queryByText('We couldn’t find this task any more. It may have been deleted.')).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('Not done:')).toBeInTheDocument();
    expect(screen.getByText('This task was marked done, so that change wasn’t saved.')).toHaveAttribute(
      'role',
      'status',
    );
    // The box focus was on is gone with the controls: focus goes to the Done line, not `<body>`.
    await waitFor(() => expect(document.activeElement).toBe(line.closest('[tabindex="-1"]')));
  });

  it('a step change refused while the person had moved on leaves focus where they went', async () => {
    taskMock.mockResolvedValueOnce(detail({ kind: 'get-done', steps: STEPS }));
    await renderReady();
    const answer = deferred<never>();
    stepsMock.mockReturnValue(answer.promise);
    taskMock.mockResolvedValue(doneTask());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check the redirects' }));
    // Somewhere that outlives the page's re-read.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    onTestFinished(() => elsewhere.remove());
    act(() => elsewhere.focus());
    await act(async () => answer.reject(new WorkspaceApiError('/tasks/a1/t1/steps', 404)));
    await screen.findByText(/^Done · You marked it done/);
    await waitFor(() => expect(taskMock).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a Done task shows no finish date and no field to set one (TASK-951)', async () => {
    // With a date: neither the line nor Change.
    taskMock.mockResolvedValue(doneTask({ finishBy: { date: '2026-11-14', daysLeft: 23 } }));
    const view = await renderReady();
    expect(screen.queryByText(/Finish by/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    view.unmount();
    // Without one: no Add a finish date either.
    taskMock.mockResolvedValue(doneTask());
    await renderReady();
    expect(screen.queryByRole('button', { name: 'Add a finish date' })).toBeNull();
  });

  it('a Done time it can’t read still says it was marked done', async () => {
    taskMock.mockResolvedValue(doneTask({ doneAt: 'nonsense' }));
    await renderReady();
    expect(within(latestUpdate()).getByText('Done · You marked it done.')).toBeInTheDocument();
  });

  it('Reopen opens the what’s-left box, and sending reopens the task', async () => {
    taskMock.mockResolvedValueOnce(doneTask());
    await renderReady();
    const reopen = screen.getByRole('button', { name: 'Reopen' });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(reopen);
    expect(reopen).toHaveAttribute('aria-expanded', 'true');
    const box = screen.getByRole('textbox', { name: NOT_YET_BOX });
    expect(document.activeElement).toBe(box);
    expect(
      screen.getByText('Sending this reopens the task, and Quill starts checking in again.'),
    ).toBeInTheDocument();
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    taskMock.mockResolvedValue(detail({ kind: 'get-done', steps: STEPS }));
    fireEvent.change(box, { target: { value: 'Redo the redirects.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(reopenMock).toHaveBeenCalledWith('a1', 't1', {
        text: 'Redo the redirects.',
        requestId: expect.any(String),
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull());
    expect(screen.getByText('Sent. Quill is checking in now.')).toBeInTheDocument();
  });

  it('a Done task without edit can’t reopen it, and the note says who can', async () => {
    taskMock.mockResolvedValue(doneTask({ permissions: { fire: false, stop: false, edit: false } }));
    await renderReady();
    const reopen = screen.getByRole('button', { name: 'Reopen' });
    expect(reopen).toBeDisabled();
    const note = screen.getByText('Done. Only someone who manages this agent’s tasks can reopen it.');
    expect(reopen).toHaveAttribute('aria-describedby', note.id);
  });
});

describe('TaskPage: ⋯ › Duplicate and the paused copy (TASK-953)', () => {
  const NOT_CONFIRMED = 'We couldn’t confirm the copy was made. Try again, and it won’t be made twice.';
  const COPY_NOT_ALLOWED = 'You can’t copy this task, because you no longer manage this agent’s tasks.';
  const COPY_LINE = 'This is a paused copy. Change what you need, then press Resume.';
  const GONE = 'We couldn’t find this task. It may have been deleted, or it belongs to someone else.';
  const JUST_NOW = 'We couldn’t copy this task just now. Try again.';

  const more = () => screen.getByRole('button', { name: 'More actions' });

  /** Opens ⋯ from the keyboard (TaskSteps' way) and chooses Duplicate. */
  async function chooseDuplicate() {
    const trigger = more();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
  }

  it('⋯ › Duplicate copies the task with a request id, and hands the copy’s id to the shell without reading the task again', async () => {
    taskMock.mockResolvedValue(detail());
    duplicateMock.mockResolvedValue({ routineId: 'rtn_copy' });
    const { onDuplicated } = await renderReady();
    const reads = taskMock.mock.calls.length;
    await chooseDuplicate();
    await waitFor(() => expect(onDuplicated).toHaveBeenCalledWith('rtn_copy'));
    expect(duplicateMock).toHaveBeenCalledTimes(1);
    expect(duplicateMock).toHaveBeenCalledWith('a1', 't1', { requestId: expect.any(String) });
    expect(taskMock).toHaveBeenCalledTimes(reads);
  });

  it('a press whose answer never came keeps its request id, and the retry sends the same one', async () => {
    taskMock.mockResolvedValue(detail());
    duplicateMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce({ routineId: 'rtn_copy' });
    const { onDuplicated } = await renderReady();
    await chooseDuplicate();
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_CONFIRMED);
    await waitFor(() => expect(more()).toBeEnabled());

    await chooseDuplicate();
    await waitFor(() => expect(onDuplicated).toHaveBeenCalledWith('rtn_copy'));
    expect(duplicateMock).toHaveBeenCalledTimes(2);
    expect(duplicateMock.mock.calls[1]![2].requestId).toBe(duplicateMock.mock.calls[0]![2].requestId);
  });

  it('an answered refusal ends the request, so the next press sends a new id', async () => {
    taskMock.mockResolvedValue(detail());
    duplicateMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 403))
      .mockResolvedValueOnce({ routineId: 'rtn_copy' });
    await renderReady();
    await chooseDuplicate();
    expect(await screen.findByRole('alert')).toHaveTextContent(COPY_NOT_ALLOWED);
    await waitFor(() => expect(more()).toBeEnabled());

    await chooseDuplicate();
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledTimes(2));
    expect(duplicateMock.mock.calls[1]![2].requestId).not.toBe(
      duplicateMock.mock.calls[0]![2].requestId,
    );
  });

  it('a Check now in between doesn’t end an unconfirmed copy, so the retry still can’t make two', async () => {
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockResolvedValue({ status: 'ok' });
    duplicateMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce({ routineId: 'rtn_copy' });
    await renderReady();
    await chooseDuplicate();
    await screen.findByRole('alert');
    await waitFor(() => expect(more()).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(fireNowMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(more()).toBeEnabled());

    await chooseDuplicate();
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledTimes(2));
    expect(duplicateMock.mock.calls[1]![2].requestId).toBe(duplicateMock.mock.calls[0]![2].requestId);
  });

  it('a refused copy in between doesn’t end an unconfirmed Check now, so the retry still can’t start two', async () => {
    taskMock.mockResolvedValue(detail());
    fireNowMock.mockRejectedValueOnce(new RoutineApiError(503)).mockResolvedValueOnce({ status: 'ok' });
    duplicateMock.mockRejectedValueOnce(new WorkspaceApiError('/x', 403));
    await renderReady();
    const check = screen.getByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    await screen.findByRole('alert');
    await waitFor(() => expect(more()).toBeEnabled());

    await chooseDuplicate();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(COPY_NOT_ALLOWED));
    await waitFor(() => expect(check).toBeEnabled());

    fireEvent.click(check);
    await waitFor(() => expect(fireNowMock).toHaveBeenCalledTimes(2));
    expect(fireNowMock.mock.calls[1]![0].requestId).toBe(fireNowMock.mock.calls[0]![0].requestId);
  });

  it.each([
    { status: 400, text: 'We couldn’t copy this task as it is. Change it in Quill’s settings first.', destructive: true },
    { status: 404, text: GONE, destructive: true },
    { status: 401, text: HTTP_SESSION_ENDED, destructive: false },
    { status: 409, text: JUST_NOW, destructive: true },
  ])('a refused copy says why: $status', async ({ status, text, destructive }) => {
    taskMock.mockResolvedValue(detail());
    duplicateMock.mockRejectedValue(new WorkspaceApiError('/x', status));
    await renderReady();
    await chooseDuplicate();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert.className.includes('destructive')).toBe(destructive);
  });

  it('after a failed Duplicate, focus goes back to the ⋯', async () => {
    const answer = deferred<{ routineId: string }>();
    taskMock.mockResolvedValue(detail());
    duplicateMock.mockReturnValueOnce(answer.promise);
    await renderReady();
    await chooseDuplicate();
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledTimes(1));
    dropFocusOnBody();

    await act(async () => answer.reject(new WorkspaceApiError('/x', 403)));
    await screen.findByRole('alert');
    await waitFor(() => expect(more()).toBeEnabled());
    await waitFor(() => expect(document.activeElement).toBe(more()));
  });

  it('without edit but able to start check-ins, only the ⋯ is off, and the note says why', async () => {
    taskMock.mockResolvedValue(detail({ permissions: { fire: true, stop: true, edit: false } }));
    await renderReady();
    expect(more()).toBeDisabled();
    expect(more()).toHaveAccessibleDescription(COPY_NOT_ALLOWED);
    for (const name of ['Check now', 'Pause']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('aria-describedby');
    }
  });

  it.each([
    { what: 'a paused task', over: { enabled: false, nextCheckAt: null } },
    { what: 'a get-done task', over: { kind: 'get-done' as const } },
  ])('Duplicate is offered on $what', async ({ over }) => {
    taskMock.mockResolvedValue(detail(over));
    await renderReady();
    expect(more()).toBeEnabled();
    const trigger = more();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
  });

  it('the copy’s page says once that it’s a paused copy, with the link to its agent’s settings', async () => {
    taskMock.mockResolvedValue(detail({ enabled: false, nextCheckAt: null }));
    const { onNavigate } = await renderReady({ justCopied: true });
    expect(screen.getByText(COPY_LINE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Change it in Quill’s settings' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'agent-settings', id: 'a1', section: 'routines' });
  });

  it.each([
    { what: 'it isn’t a fresh copy', justCopied: false, over: { enabled: false, nextCheckAt: null } },
    { what: 'the copy is already running', justCopied: true, over: {} },
    {
      what: 'the person can’t edit',
      justCopied: true,
      over: {
        enabled: false,
        nextCheckAt: null,
        permissions: { fire: true, stop: true, edit: false },
      },
    },
  ])('no paused-copy line when $what', async ({ justCopied, over }) => {
    taskMock.mockResolvedValue(detail(over));
    await renderReady({ justCopied });
    expect(screen.queryByText(COPY_LINE)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change it in Quill’s settings' })).toBeNull();
  });

  it('Resume uses the line up: it doesn’t come back when the copy is paused again', async () => {
    const paused = detail({ enabled: false, nextCheckAt: null });
    taskMock
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(detail({ revision: 'rev-2' }))
      .mockResolvedValue(detail({ enabled: false, nextCheckAt: null, revision: 'rev-3' }));
    updateMock.mockResolvedValue(ROUTINE);
    await renderReady({ justCopied: true });
    expect(screen.getByText(COPY_LINE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const pause = await screen.findByRole('button', { name: 'Pause' });
    await settled(pause, 2);
    expect(screen.queryByText(COPY_LINE)).toBeNull();

    fireEvent.click(pause);
    const resume = await screen.findByRole('button', { name: 'Resume' });
    await settled(resume, 3);
    expect(screen.queryByText(COPY_LINE)).toBeNull();
  });
});
