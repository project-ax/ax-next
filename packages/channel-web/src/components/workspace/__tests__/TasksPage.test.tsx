/**
 * The Tasks page (TASK-909): every task the person owns, across the agents
 * they can see, grouped by what needs them.
 *
 * Driven through the REAL `useTasks` and the real page, with only the network
 * call mocked, so each case is what the reader would actually see. The copy is
 * asserted verbatim because it is decided (TASK-909 decisions row 11), and its
 * apostrophe is U+2019, not the ASCII one.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import type {
  TaskRow,
  TaskRowReport,
  TasksResponse,
  UnavailableAgent,
} from '@/lib/workspace-types';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { useTasks, type TasksState } from '@/lib/workspace-tasks';
import { TasksPage } from '../TasksPage';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { tasks: vi.fn(), taskAgents: vi.fn() } };
});

const tasksMock = vi.mocked(workspaceApi.tasks);

const JUNIPER: UnavailableAgent = { agentId: 'a2', agentName: 'Juniper' };
const QUILL: UnavailableAgent = { agentId: 'a3', agentName: 'Quill' };

function report(
  status: TaskRowReport['status'],
  over: Partial<TaskRowReport> = {},
): TaskRowReport {
  return {
    status,
    update: 'Nothing new since this morning.',
    ask: null,
    reading: null,
    doneClaimed: false,
    reportedAt: '2026-10-22T10:00:00.000Z',
    ...over,
  };
}

/** A task on Caveman that has never reported, unless `over` says otherwise. */
function row(name: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'a1',
    agentName: 'Caveman',
    routineId: `r-${name}`,
    name,
    enabled: true,
    kind: 'stay-on-top',
    steps: null,
    finishBy: null,
    task: null,
    noRecentUpdate: null,
    doneAt: null,
    canMarkDone: true,
    ...over,
  };
}

function page(tasks: TaskRow[], unavailableAgents: UnavailableAgent[] = []): TasksResponse {
  return { tasks, unavailableAgents };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The shell's side of the page: it owns the read and hands the state down (TASK-933). */
function Harness({
  leading,
  onNavigate,
}: {
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const { state, retry, reload } = useTasks();
  return <TasksPage state={state} retry={retry} leading={leading} onNavigate={onNavigate} onTaskWriteSucceeded={reload} />;
}

/** The page, with the shell's `navigate` stood in for by a spy. */
function renderPage(leading?: ReactNode) {
  const onNavigate = vi.fn<(route: WorkspaceRoute) => void>();
  const view = render(<Harness leading={leading} onNavigate={onNavigate} />);
  return { ...view, onNavigate };
}

/** The group headings, in page order, as text. */
function groupHeadings(): string[] {
  return screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
}

let warn: MockInstance;

beforeEach(() => {
  tasksMock.mockReset();
  // `useTasks` logs every failed read, and several cases below fail on purpose.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('TasksPage (TASK-909)', () => {
  it('opens a keyboard-accessible New task dialog with an honest no-eligible-agent state (PR4)', async () => {
    tasksMock.mockResolvedValue(page([]));
    vi.mocked(workspaceApi.taskAgents).mockResolvedValue({ agents: [] });
    renderPage();
    await screen.findByText('No tasks yet');
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(await screen.findByRole('dialog', { name: 'New task' })).toBeVisible();
    expect(await screen.findByText('No agents are available for a new task. Join an agent or create one first.')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Agent' })).not.toBeInTheDocument();
  });
  it('shows Repeat failures and durable waiting counts without a fabricated report or Today task', async () => {
    tasksMock.mockResolvedValue(page([row('Daily digest', { kind: 'repeat', task: null, canMarkDone: false,
      repeat: { lastRunAt: '2026-10-26T12:00:00Z', status: 'error', error: 'Delivery failed.', warning: null, active: 0, waiting: 2, sharedThread: false, appUpdates: true } })]));
    renderPage();
    expect(await screen.findByText('Last run failed.')).toBeVisible();
    expect(screen.getByText('Delivery failed.')).toBeVisible();
    expect(screen.getByText('2 app updates waiting')).toBeVisible();
    expect(screen.queryByText('No update yet')).not.toBeInTheDocument();
  });
  it('draws the state it is handed, without reading anything (TASK-933)', () => {
    const state: TasksState = {
      kind: 'ready',
      tasks: [row('Sweep', { task: report('on-track') })],
      unavailableAgents: [],
      refreshing: false,
      refreshFailed: false,
    };
    render(<TasksPage onTaskWriteSucceeded={vi.fn()} state={state} retry={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText('Sweep')).toBeTruthy();
    expect(tasksMock).not.toHaveBeenCalled();
  });

  it('shows the title and subtitle while it loads', () => {
    tasksMock.mockReturnValue(new Promise<TasksResponse>(() => {}));
    renderPage(<button type="button">Open navigation</button>);
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('What your agents are looking after')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    // Below `md` the shell's nav trigger is the only door to the sidebar.
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });

  it('groups tasks under Needs you, Off track, On track and No update yet, with counts, hiding empty groups', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Weekly digest'),
        row('Morning inbox', { task: report('needs-you') }),
        row('Support queue', { task: report('on-track') }),
        row('Overdue invoices', {
          task: report('needs-you', { reportedAt: '2026-10-22T10:05:00.000Z' }),
        }),
      ]),
    );
    renderPage();
    await screen.findByText('Morning inbox');
    expect(groupHeadings()).toEqual(['Needs you · 2', 'On track · 1', 'No update yet · 1']);

    // Each count is the rows under its own heading.
    const needsYou = screen.getByRole('region', { name: 'Needs you · 2' });
    expect(within(needsYou).getAllByRole('listitem')).toHaveLength(2);
    expect(within(needsYou).getByText('Morning inbox')).toBeInTheDocument();
    expect(within(needsYou).getByText('Overdue invoices')).toBeInTheDocument();
    const noUpdate = screen.getByRole('region', { name: 'No update yet · 1' });
    expect(within(noUpdate).getByText('Weekly digest')).toBeInTheDocument();
  });

  it('collapses paused tasks behind a toggle that counts them', async () => {
    tasksMock.mockResolvedValueOnce(
      page([
        row('Support queue', { task: report('needs-you') }),
        // Paused outranks whatever the last report said.
        row('Old inbox', { enabled: false, task: report('needs-you') }),
      ]),
    );
    const first = renderPage();
    await screen.findByText('Support queue');
    expect(groupHeadings()).toEqual(['Needs you · 1']);
    expect(screen.queryByText('Old inbox')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show 1 paused task' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('Old inbox')).toBeInTheDocument();
    expect(toggle).toHaveAccessibleName('Hide paused tasks');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(groupHeadings()).toEqual(['Needs you · 1']);
    first.unmount();

    tasksMock.mockResolvedValueOnce(
      page([
        row('Old inbox', { enabled: false, task: report('needs-you') }),
        row('Old digest', { enabled: false }),
      ]),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: 'Show 2 paused tasks' })).toBeInTheDocument();
    // Every task paused is still not "no tasks".
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });

  it('groups No recent update between Off track and On track, and moves three misses to Needs you', async () => {
    const miss = (inARow: number) => ({
      inARow,
      reason: 'no-report' as const,
      at: '2026-10-22T11:00:00.000Z',
      autoPaused: false,
    });
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', { task: report('on-track') }),
        row('Overdue invoices', { task: report('off-track') }),
        row('Morning inbox', { task: report('on-track'), noRecentUpdate: miss(2) }),
        row('Weekly digest', { task: report('on-track'), noRecentUpdate: miss(3) }),
      ]),
    );
    renderPage();
    await screen.findByText('Morning inbox');
    expect(groupHeadings()).toEqual([
      'Needs you · 1',
      'Off track · 1',
      'No recent update · 1',
      'On track · 1',
    ]);
    const needsYou = screen.getByRole('region', { name: 'Needs you · 1' });
    expect(within(needsYou).getByText('Weekly digest')).toBeInTheDocument();
    const quiet = screen.getByRole('region', { name: 'No recent update · 1' });
    expect(within(quiet).getByText('Morning inbox')).toBeInTheDocument();
  });

  it('a row with no recent update shows why instead of its stale update', async () => {
    const at = '2026-10-22T11:00:00.000Z';
    tasksMock.mockResolvedValue(
      page([
        row('Morning inbox', {
          task: report('on-track', { update: 'Stale: all quiet.' }),
          noRecentUpdate: { inARow: 1, reason: 'brief-too-long', at, autoPaused: false },
        }),
        row('Weekly digest', {
          task: report('on-track', { update: 'Also stale.' }),
          noRecentUpdate: { inARow: 3, reason: 'no-report', at, autoPaused: false },
        }),
      ]),
    );
    renderPage();
    await screen.findByText('Morning inbox');
    expect(screen.queryByText('Stale: all quiet.')).not.toBeInTheDocument();
    expect(screen.queryByText('Also stale.')).not.toBeInTheDocument();
    expect(screen.getByText('Its instructions are too long to load.')).toBeInTheDocument();
    const line =
      'Its last 3 check-ins didn’t leave an update. It checked in but didn’t say how it went.';
    expect(screen.getByText(line)).toHaveAttribute('title', line);
    // "checked" still dates the last real report.
    expect(screen.getAllByText(/^Caveman · checked /)).toHaveLength(2);
  });

  it('an auto-paused task says why it’s paused, behind the paused toggle', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', { task: report('on-track') }),
        row('Morning inbox', {
          enabled: false,
          task: report('on-track', { update: 'Stale: all quiet.' }),
          noRecentUpdate: {
            inARow: 5,
            reason: 'no-report',
            at: '2026-10-22T11:00:00.000Z',
            autoPaused: true,
          },
        }),
        row('Old digest', { enabled: false, task: report('on-track', { update: 'Paused by me.' }) }),
      ]),
    );
    renderPage();
    await screen.findByText('Support queue');
    const line = 'Paused after 5 check-ins in a row didn’t leave an update.';
    expect(screen.queryByText(line)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 paused tasks' }));
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText('Stale: all quiet.')).not.toBeInTheDocument();
    // A task a person paused, with no misses, keeps its update.
    expect(screen.getByText('Paused by me.')).toBeInTheDocument();
  });

  it('offers New task and chat when there are no tasks', async () => {
    tasksMock.mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask an agent in chat to keep an eye on something for you, like an inbox or a queue.',
      ),
    ).toBeInTheDocument();
    expect(groupHeadings()).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeVisible();
  });

  it('says which agents could not be read, and never claims the list is empty', async () => {
    tasksMock.mockResolvedValueOnce(page([], [JUNIPER]));
    const first = renderPage();
    expect(
      await screen.findByText(
        'We couldn’t load tasks from Juniper just now, so some may be missing.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    first.unmount();

    tasksMock.mockReset();
    const refresh = deferred<TasksResponse>();
    tasksMock
      .mockResolvedValueOnce(page([row('Support queue', { task: report('on-track') })], [JUNIPER, QUILL]))
      .mockReturnValueOnce(refresh.promise);
    renderPage();
    const note = await screen.findByText(
      'We couldn’t load tasks from Juniper and Quill just now, so some may be missing.',
    );
    expect(screen.getByText('Support queue')).toBeInTheDocument();
    // Red, and no title: it sits over rows the page can still show (lib/read-register.ts).
    const alert = note.closest('[role="alert"]') as HTMLElement;
    expect(alert.className).toContain('destructive');
    expect(within(alert).queryByRole('heading')).not.toBeInTheDocument();

    const retry = within(alert).getByRole('button', { name: 'Try again' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(tasksMock).toHaveBeenCalledTimes(2);
    expect(retry).toBeDisabled();
    expect(screen.getByText('Support queue')).toBeInTheDocument();

    await act(async () => refresh.resolve(page([row('Support queue', { task: report('on-track') })])));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Support queue')).toBeInTheDocument();
  });

  it('keeps the rows when Try again fails, and says the list may be out of date', async () => {
    tasksMock
      .mockResolvedValueOnce(page([row('Support queue', { task: report('on-track') })], [JUNIPER]))
      .mockRejectedValueOnce(new WorkspaceApiError('/tasks', 503));
    renderPage();
    const partial = 'We couldn’t load tasks from Juniper just now, so some may be missing.';
    fireEvent.click(
      within((await screen.findByText(partial)).closest('[role="alert"]') as HTMLElement).getByRole(
        'button',
        { name: 'Try again' },
      ),
    );
    expect(
      await screen.findByText(
        'We couldn’t refresh your tasks just now, so this list may be out of date.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Support queue')).toBeInTheDocument();
    expect(screen.getByText(partial)).toBeInTheDocument();
    expect(
      screen.queryByText('We couldn’t load your tasks just now. Nothing was lost.'),
    ).not.toBeInTheDocument();
    // One alert, one way to try again.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('draws an update with markdown or HTML as plain text', async () => {
    const UPDATE = '**Done** <b>3</b> [docs](https://x.test) <img src=x onerror=alert(1)>';
    const NAME = '**Weekly** <b>digest</b>';
    tasksMock.mockResolvedValue(
      page([row(NAME, { task: report('on-track', { update: UPDATE }) })]),
    );
    const { container } = renderPage();
    const update = await screen.findByTitle(UPDATE);
    expect(update.textContent).toBe(UPDATE);
    expect(screen.getByTitle(NAME).textContent).toBe(NAME);
    expect(container.querySelector('ul strong, ul b, ul img')).toBeNull();
    // The one link is the row's own (TASK-910), never one the update wrote.
    expect(container.querySelectorAll('ul a')).toHaveLength(1);
  });

  it('keeps the whole name and update in a title', async () => {
    const NAME =
      'Keep every enterprise customer’s support ticket under an hour, weekends included';
    const UPDATE = `${'Two invoices are three days old and one is waiting on Acme. '.repeat(8)}End.`;
    tasksMock.mockResolvedValue(page([row(NAME, { task: report('needs-you', { update: UPDATE }) })]));
    renderPage();
    expect(await screen.findByText(NAME)).toHaveAttribute('title', NAME);
    expect(screen.getByText(UPDATE)).toHaveAttribute('title', UPDATE);
  });

  it('dates a report from when it was written, and a never-reported task not at all', async () => {
    const NOW = new Date('2026-10-22T12:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', {
          task: report('on-track', {
            reportedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
          }),
        }),
        row('Weekly digest', { agentId: 'a2', agentName: 'Juniper' }),
      ]),
    );
    renderPage();
    expect(await screen.findByText('Caveman · checked 4 min ago')).toBeInTheDocument();
    const digest = screen.getByText('Weekly digest').closest('li') as HTMLElement;
    expect(within(digest).getByText('Juniper').textContent).toBe('Juniper');

    // A tab left open keeps counting instead of saying "4 min ago" forever.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('Caveman · checked 6 min ago')).toBeInTheDocument();
  });

  it('dates rows a retry brings in against the clock now, not when the page opened', async () => {
    const OPENED = new Date('2026-10-22T12:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(OPENED);
    const later = new Date(OPENED.getTime() + 15 * 60_000);
    tasksMock
      .mockResolvedValueOnce(page([row('Weekly digest')], [JUNIPER]))
      .mockResolvedValueOnce(
        page([
          row('Weekly digest'),
          row('Support queue', {
            agentId: 'a2',
            agentName: 'Juniper',
            task: report('on-track', {
              reportedAt: new Date(later.getTime() - 4 * 60_000).toISOString(),
            }),
          }),
        ]),
      );
    renderPage();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    // Nothing on the first answer had a time, so no clock was running.
    vi.setSystemTime(later);
    fireEvent.click(retry);
    expect(await screen.findByText('Juniper · checked 4 min ago')).toBeInTheDocument();
  });

  it('keeps the clock running when the only report is on a paused task', async () => {
    const NOW = new Date('2026-10-22T12:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    tasksMock.mockResolvedValue(
      page([
        row('Old inbox', {
          enabled: false,
          task: report('needs-you', {
            reportedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
          }),
        }),
        row('Weekly digest'),
      ]),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 paused task' }));
    expect(screen.getByText('Caveman · checked 4 min ago')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('Caveman · checked 6 min ago')).toBeInTheDocument();
  });

  it('offers Try again when the page could not load', async () => {
    tasksMock
      .mockRejectedValueOnce(new WorkspaceApiError('/tasks', 500))
      .mockResolvedValueOnce(page([row('Support queue', { task: report('on-track') })]));
    renderPage();
    expect(
      await screen.findByText('We couldn’t load your tasks just now. Nothing was lost.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert').className).toContain('destructive');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Support queue')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(tasksMock).toHaveBeenCalledTimes(2);
  });

  it('asks to sign in again when the session ended, with nothing to retry', async () => {
    tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 401));
    renderPage();
    expect(await screen.findByText(HTTP_SESSION_ENDED)).toBeInTheDocument();
    // Signing in is not a repair, so the register is the default one.
    expect(screen.getByRole('alert').className).not.toContain('destructive');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('each task opens its page', async () => {
    tasksMock.mockResolvedValue(
      page([row('Support queue', { routineId: 't1', task: report('needs-you') })]),
    );
    const { onNavigate } = renderPage();
    const link = await screen.findByRole('link', { name: /Support queue/ });
    expect(link).toHaveAttribute('href', '/workspace/tasks/a1/t1');

    fireEvent.click(link, { ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'task',
      agentId: 'a1',
      routineId: 't1',
    });
  });

  it('a get-done task’s row says how many steps are done, in place of when it checked (TASK-948)', async () => {
    const NOW = new Date('2026-10-22T12:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    tasksMock.mockResolvedValue(
      page([
        row('Move the help docs', {
          kind: 'get-done',
          steps: { done: 2, total: 5 },
          task: report('on-track', {
            reportedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
          }),
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText('Caveman · 2 of 5 steps')).toBeInTheDocument();
    expect(screen.queryByText(/checked/)).toBeNull();
  });

  it('a get-done task with no steps yet reads as any other row (TASK-948)', async () => {
    const NOW = new Date('2026-10-22T12:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    tasksMock.mockResolvedValue(
      page([
        row('Move the help docs', {
          kind: 'get-done',
          steps: { done: 0, total: 0 },
          task: report('on-track', {
            reportedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
          }),
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText('Caveman · checked 4 min ago')).toBeInTheDocument();
  });

  it('a get-done row says how long is left after its steps (TASK-951)', async () => {
    const NOW = new Date('2026-10-22T12:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const checked = report('on-track', { reportedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString() });
    const steps = { done: 2, total: 5 };
    tasksMock.mockResolvedValue(
      page([
        row('Nine', { kind: 'get-done', steps, finishBy: { date: '2026-10-31', daysLeft: 9 } }),
        row('Today', { kind: 'get-done', steps, finishBy: { date: '2026-10-22', daysLeft: 0 } }),
        row('Late', { kind: 'get-done', steps, finishBy: { date: '2026-10-19', daysLeft: -3 } }),
        row('No steps, never reported', {
          kind: 'get-done',
          steps: { done: 0, total: 0 },
          finishBy: { date: '2026-10-31', daysLeft: 9 },
        }),
        row('No steps, reported', {
          kind: 'get-done',
          steps: { done: 0, total: 0 },
          task: checked,
          finishBy: { date: '2026-10-31', daysLeft: 9 },
        }),
        row('Undated', { kind: 'get-done', steps, finishBy: null }),
        // A stay-on-top row has no finish date; if one arrives, the row says nothing of it.
        row('Stay on top', { kind: 'stay-on-top', finishBy: { date: '2026-10-31', daysLeft: 9 } }),
      ]),
    );
    renderPage();
    expect(await screen.findAllByText('Caveman · 2 of 5 steps · 9 days left')).toHaveLength(1);
    expect(screen.getByText('Caveman · 2 of 5 steps · Due today')).toBeInTheDocument();
    expect(screen.getByText('Caveman · 2 of 5 steps · 3 days past its finish date')).toBeInTheDocument();
    expect(screen.getByText('Caveman · 9 days left')).toBeInTheDocument();
    expect(screen.getByText('Caveman · checked 4 min ago · 9 days left')).toBeInTheDocument();
    expect(screen.getByText('Caveman · 2 of 5 steps')).toBeInTheDocument();
    // The stay-on-top row reads as it always did: just the agent's name.
    expect(screen.getByText('Caveman')).toBeInTheDocument();
  });
});

describe('TasksPage: the agent’s reading (TASK-952)', () => {
  const OPEN_3 = { label: 'Open tickets', value: 3 };

  it('a row shows the agent’s reading under its update, muted', async () => {
    tasksMock.mockResolvedValue(
      page([row('Support queue', { task: report('on-track', { reading: OPEN_3 }) })]),
    );
    renderPage();
    const line = await screen.findByText('Caveman’s reading · Open tickets: 3');
    expect(line).toHaveClass('text-muted-foreground');
    const update = screen.getByText('Nothing new since this morning.');
    expect(update.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a row with missed check-ins shows no reading, since it shows no update', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Morning inbox', {
          task: report('on-track', { reading: OPEN_3 }),
          noRecentUpdate: {
            inARow: 1,
            reason: 'no-report',
            at: '2026-10-22T11:00:00.000Z',
            autoPaused: false,
          },
        }),
      ]),
    );
    renderPage();
    await screen.findByText('Morning inbox');
    expect(screen.queryByText('Nothing new since this morning.')).not.toBeInTheDocument();
    expect(screen.queryByText(/’s reading/)).not.toBeInTheDocument();
  });

  it('a row whose update fenced to nothing shows no reading, since it shows no update', async () => {
    tasksMock.mockResolvedValue(
      page([row('Support queue', { task: report('on-track', { update: null, reading: OPEN_3 }) })]),
    );
    renderPage();
    await screen.findByText('Support queue');
    expect(screen.queryByText(/’s reading/)).not.toBeInTheDocument();
  });

  it('a get-done row keeps its step count on its second line, and the reading after the update (TASK-948)', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Move the help docs', {
          kind: 'get-done',
          steps: { done: 2, total: 5 },
          task: report('on-track', { reading: OPEN_3 }),
        }),
      ]),
    );
    renderPage();
    const count = await screen.findByText('Caveman · 2 of 5 steps');
    const update = screen.getByText('Nothing new since this morning.');
    const line = screen.getByText('Caveman’s reading · Open tickets: 3');
    const after = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after(count, update)).toBeTruthy();
    expect(after(update, line)).toBeTruthy();
  });

  it('a row without a reading shows none', async () => {
    tasksMock.mockResolvedValue(page([row('Support queue', { task: report('on-track') })]));
    renderPage();
    await screen.findByText('Nothing new since this morning.');
    expect(screen.queryByText(/’s reading/)).not.toBeInTheDocument();
  });

  it('draws a label with HTML as text, and the row keeps its one link', async () => {
    const label = '<img src=x onerror=alert(1)>';
    tasksMock.mockResolvedValue(
      page([row('Support queue', { task: report('on-track', { reading: { label, value: 3 } }) })]),
    );
    const { container } = renderPage();
    const line = await screen.findByText(`Caveman’s reading · ${label}: 3`);
    expect(line.textContent).toBe(`Caveman’s reading · ${label}: 3`);
    expect(container.querySelector('ul img')).toBeNull();
    expect(container.querySelectorAll('ul a')).toHaveLength(1);
  });
});

describe('TasksPage: Done tasks (TASK-950)', () => {
  const NOW_MS = Date.parse('2026-10-24T12:00:00Z');
  const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  // Only the clock is faked: the page's reads and `findBy*` still run on real timers.
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ['Date'] });
  });

  /** A finished get-done task: off, completed at `doneAt`, its last report the claim. */
  function done(name: string, doneAt: string, over: Partial<TaskRow> = {}): TaskRow {
    return row(name, {
      enabled: false,
      kind: 'get-done',
      doneAt,
      task: report('needs-you', { update: `${name} is finished.`, doneClaimed: true }),
      ...over,
    });
  }

  const after = (a: Node, b: Node) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

  it('Current shows the groups, then Done this week, then paused', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', { task: report('on-track') }),
        done('Tidy the garage', ago(2 * HOUR)),
        row('Old inbox', { enabled: false }),
      ]),
    );
    renderPage();
    await screen.findByText('Tidy the garage');
    expect(groupHeadings()).toEqual(['On track · 1', 'Done this week · 1']);

    const onTrack = screen.getByRole('region', { name: 'On track · 1' });
    const doneWeek = screen.getByRole('region', { name: 'Done this week · 1' });
    const paused = screen.getByRole('button', { name: 'Show 1 paused task' });
    expect(after(onTrack, doneWeek)).toBeTruthy();
    expect(after(doneWeek, paused)).toBeTruthy();

    // A done row names when it finished, and still shows the agent's last update.
    expect(
      within(doneWeek).getByText(/^Caveman · Done (at |yesterday at |tomorrow at |on )/),
    ).toBeInTheDocument();
    expect(within(doneWeek).getByText('Tidy the garage is finished.')).toBeInTheDocument();
  });

  it('a done row with a finish date counts no days left, under Current and under Done (TASK-951)', async () => {
    tasksMock.mockResolvedValue(
      page([done('Tidy the garage', ago(2 * HOUR), { finishBy: { date: '2026-10-31', daysLeft: 7 } })]),
    );
    renderPage();
    const doneWeek = await screen.findByRole('region', { name: 'Done this week · 1' });
    expect(
      within(doneWeek).getByText(/^Caveman · Done (at |yesterday at |tomorrow at |on )/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/days? left|Due today|past its finish date/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Done/ }));
    expect(screen.getByRole('region', { name: 'Done · 1' })).toBeInTheDocument();
    expect(screen.queryByText(/days? left|Due today|past its finish date/)).toBeNull();
  });

  it('a done row says only "Done" when its time cannot be read', async () => {
    tasksMock.mockResolvedValue(page([done('Tidy the garage', 'not a time')]));
    renderPage();
    await screen.findByRole('radiogroup', { name: 'Which tasks to show' });
    fireEvent.click(screen.getByRole('radio', { name: /^Done/ }));
    expect(screen.getByText('Caveman · Done')).toBeInTheDocument();
  });

  it('the toggle shows only when a task is done, and counts them', async () => {
    tasksMock.mockResolvedValueOnce(page([row('Support queue', { task: report('on-track') })]));
    const first = renderPage();
    await screen.findByText('Support queue');
    expect(screen.queryByRole('radiogroup', { name: 'Which tasks to show' })).not.toBeInTheDocument();
    first.unmount();

    tasksMock.mockResolvedValueOnce(
      page([done('One', ago(HOUR)), done('Two', ago(9 * DAY)), row('Support queue')]),
    );
    renderPage();
    await screen.findByText('Support queue');
    const group = screen.getByRole('radiogroup', { name: 'Which tasks to show' });
    expect(within(group).getByRole('radio', { name: /^Current/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /^Done/ })).toHaveTextContent('2');
  });

  it('Done lists every done task, newest first, and nothing else', async () => {
    tasksMock.mockResolvedValue(
      page([
        done('Oldest', ago(20 * DAY)),
        done('Newest', ago(HOUR)),
        done('Middle', ago(3 * DAY)),
        row('Support queue', { task: report('needs-you') }),
        row('Old inbox', { enabled: false }),
      ]),
    );
    renderPage();
    await screen.findByText('Newest');
    fireEvent.click(screen.getByRole('radio', { name: /^Done/ }));

    expect(groupHeadings()).toEqual(['Done · 3']);
    const section = screen.getByRole('region', { name: 'Done · 3' });
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((li) => within(li).getByText(/^(Oldest|Newest|Middle)$/).textContent),
    ).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(screen.queryByText('Support queue')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /paused task/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /^Current/ }));
    expect(groupHeadings()).toEqual(['Needs you · 1', 'Done this week · 2']);
    expect(screen.queryByText('Oldest')).not.toBeInTheDocument();
  });

  it('a task done 8 days ago is only under Done', async () => {
    tasksMock.mockResolvedValue(
      page([done('Last week', ago(8 * DAY)), row('Support queue', { task: report('on-track') })]),
    );
    renderPage();
    await screen.findByText('Support queue');
    expect(screen.queryByText('Last week')).not.toBeInTheDocument();
    expect(groupHeadings()).toEqual(['On track · 1']);
    fireEvent.click(screen.getByRole('radio', { name: /^Done/ }));
    expect(screen.getByText('Last week')).toBeInTheDocument();
  });

  it('Current says where finished tasks went when it has nothing else', async () => {
    const line = 'No tasks need looking after right now. Finished ones are under Done.';
    tasksMock.mockResolvedValueOnce(page([done('Last week', ago(8 * DAY))]));
    const first = renderPage();
    await screen.findByRole('radiogroup', { name: 'Which tasks to show' });
    expect(screen.getByText(line)).toBeInTheDocument();
    // It is not the "no tasks yet" teaching: there are tasks.
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    first.unmount();

    // A paused task, or a recent done one, is something to look at.
    tasksMock.mockResolvedValueOnce(
      page([done('Last week', ago(8 * DAY)), row('Old inbox', { enabled: false })]),
    );
    const second = renderPage();
    await screen.findByRole('button', { name: 'Show 1 paused task' });
    expect(screen.queryByText(line)).not.toBeInTheDocument();
    second.unmount();

    tasksMock.mockResolvedValueOnce(page([done('This week', ago(HOUR))]));
    renderPage();
    await screen.findByText('This week');
    expect(screen.queryByText(line)).not.toBeInTheDocument();
  });

  it('keeps the load alerts in both views', async () => {
    tasksMock.mockResolvedValue(page([done('Tidy the garage', ago(HOUR))], [JUNIPER]));
    renderPage();
    const note = 'We couldn’t load tasks from Juniper just now, so some may be missing.';
    expect(await screen.findByText(note)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Done/ }));
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('the choice survives a re-read, and falls back to Current when the last done task is reopened', () => {
    const ready = (tasks: TaskRow[]): TasksState => ({
      kind: 'ready',
      tasks,
      unavailableAgents: [],
      refreshing: false,
      refreshFailed: false,
    });
    const supportQueue = () => row('Support queue', { task: report('on-track') });
    const pageFor = (tasks: TaskRow[]) => (
      <TasksPage onTaskWriteSucceeded={vi.fn()} state={ready(tasks)} retry={vi.fn()} onNavigate={vi.fn()} />
    );
    const view = render(pageFor([done('Old one', ago(9 * DAY)), supportQueue()]));
    fireEvent.click(screen.getByRole('radio', { name: /^Done/ }));
    expect(groupHeadings()).toEqual(['Done · 1']);

    // A re-read that still has done tasks stays on Done.
    view.rerender(pageFor([done('Old one', ago(9 * DAY)), done('New one', ago(HOUR)), supportQueue()]));
    expect(groupHeadings()).toEqual(['Done · 2']);

    // The last done task is reopened: no toggle, and Current.
    view.rerender(pageFor([row('Old one', { task: report('on-track') }), supportQueue()]));
    expect(groupHeadings()).toEqual(['On track · 2']);
    expect(screen.queryByRole('radiogroup', { name: 'Which tasks to show' })).not.toBeInTheDocument();

    // The next task marked done brings the toggle back on Current: the page doesn't jump to Done.
    view.rerender(pageFor([done('Support queue', ago(HOUR)), row('Old one', { task: report('on-track') })]));
    expect(screen.getByRole('radio', { name: 'Current' })).toBeChecked();
    expect(groupHeadings()).not.toContain('Done · 1');
  });
});


describe('missed check-in metadata (TASK-940)', () => {
  it.each([true, false])('dates the miss even when an older report exists: %s', async (hasReport) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
    tasksMock.mockResolvedValue(page([row('Inbox', {
      task: hasReport ? report('on-track', { reportedAt: '2026-10-25T20:00:00Z' }) : null,
      noRecentUpdate: { inARow: 1, reason: 'failed', at: '2026-10-26T14:59:00Z', autoPaused: false },
    })]));
    renderPage();
    expect(await screen.findByText('Caveman · checked 1 min ago')).toBeInTheDocument();
    expect(screen.queryByText(/checked 19 hr ago/)).toBeNull();
  });
});


describe('TasksPage: claimed completion wording (TASK-959)', () => {
  it('says the agent thinks it is done beside its update, while ordinary and Done rows do not', async () => {
    tasksMock.mockResolvedValue(page([
      row('Claimed', { kind: 'get-done', task: report('needs-you', { doneClaimed: true, update: 'All articles moved.' }) }),
      row('Ordinary', { task: report('needs-you') }),
      row('Finished', { enabled: false, kind: 'get-done', doneAt: new Date().toISOString(), task: report('needs-you', { doneClaimed: true }) }),
    ]));
    renderPage();
    const claim = (await screen.findByText('Claimed')).closest('a')!;
    expect(within(claim).getByText('Caveman thinks this is done.')).toBeVisible();
    expect(within(claim).getByText('All articles moved.')).toBeVisible();
    for (const name of ['Ordinary', 'Finished']) {
      expect(within(screen.getByText(name).closest('a')!).queryByText('Caveman thinks this is done.')).toBeNull();
    }
  });

  it('keeps missed-check-in wording ahead of an old claim', async () => {
    tasksMock.mockResolvedValue(page([row('Missed', {
      kind: 'get-done',
      task: report('needs-you', { doneClaimed: true, update: 'Old update.' }),
      noRecentUpdate: { inARow: 3, reason: 'no-report', at: new Date().toISOString(), autoPaused: false },
    })]));
    renderPage();
    const link = (await screen.findByText('Missed')).closest('a')!;
    expect(link).toHaveTextContent('Its last 3 check-ins didn’t leave an update.');
    expect(within(link).queryByText('Caveman thinks this is done.')).toBeNull();
    expect(within(link).queryByText('Old update.')).toBeNull();
  });
});
