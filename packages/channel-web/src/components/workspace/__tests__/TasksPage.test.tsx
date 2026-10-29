/**
 * The Tasks page (TASK-909): every task the person owns, across the agents
 * they can see, grouped by what needs them, in the minimal layout (2026-10-29).
 *
 * Driven through the REAL `useTasks` and the real page, with only the network
 * call mocked, so each case is what the reader would actually see. The copy is
 * asserted verbatim because it is decided (TASK-909 decisions row 11), and its
 * apostrophe is U+2019, not the ASCII one. Where words became an icon or a
 * short fact, the case asks for the role and accessible name, or the hidden
 * sentence the short fact stands for.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  onReply,
}: {
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
  onReply: (route: { kind: 'task'; agentId: string; routineId: string }) => void;
}) {
  const { state, retry, reload } = useTasks();
  return <TasksPage state={state} retry={retry} leading={leading} onNavigate={onNavigate} onReply={onReply} onTaskWriteSucceeded={reload} />;
}

/** The page, with the shell's `navigate` and its Reply stood in for by spies. */
function renderPage(leading?: ReactNode) {
  const onNavigate = vi.fn<(route: WorkspaceRoute) => void>();
  const onReply = vi.fn<(route: { kind: 'task'; agentId: string; routineId: string }) => void>();
  const view = render(<Harness leading={leading} onNavigate={onNavigate} onReply={onReply} />);
  return { ...view, onNavigate, onReply };
}

/** The group headings, in page order, as text. */
function groupHeadings(): string[] {
  return screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
}

/** The task's row link, found by the task's name. */
function rowLink(name: string): HTMLElement {
  return screen.getByText(name, { selector: 'a span' }).closest('a') as HTMLElement;
}

function ready(tasks: TaskRow[]): TasksState {
  return { kind: 'ready', tasks, unavailableAgents: [], refreshing: false, refreshFailed: false };
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
  it('shows Repeat failures and durable waiting counts on one line, without a fabricated report or Today task', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-29T12:00:00Z'), toFake: ['Date'] });
    tasksMock.mockResolvedValue(page([row('Daily digest', { kind: 'repeat', task: null, canMarkDone: false,
      repeat: { lastRunAt: '2026-10-26T12:00:00Z', status: 'error', error: 'Delivery failed.', warning: null, active: 0, waiting: 2, sharedThread: false, appUpdates: true } })]));
    renderPage();
    const line = 'Last run failed. Delivery failed. · 2 app updates waiting';
    expect(await screen.findByText(line)).toHaveAttribute('title', line);
    expect(groupHeadings()).toEqual(['Repeat jobs 1']);
    expect(screen.queryByText('No update yet')).not.toBeInTheDocument();
    // Its right-hand fact is the last run's day; the sentence says when.
    expect(within(rowLink('Daily digest')).getByText('Last run 3 days ago')).toBeInTheDocument();
  });
  it('draws the state it is handed, without reading anything (TASK-933)', () => {
    render(<TasksPage onTaskWriteSucceeded={vi.fn()} state={ready([row('Sweep', { task: report('on-track') })])} retry={vi.fn()} onNavigate={vi.fn()} onReply={vi.fn()} />);
    expect(screen.getByText('Sweep')).toBeTruthy();
    expect(tasksMock).not.toHaveBeenCalled();
  });

  it('shows the title, and no subtitle, while it loads', () => {
    tasksMock.mockReturnValue(new Promise<TasksResponse>(() => {}));
    renderPage(<button type="button">Open navigation</button>);
    const title = screen.getByRole('heading', { level: 1, name: 'Tasks' });
    expect(title).toHaveClass('text-[24px]');
    // The title and New task sit in the rows' centred column, nav trigger first.
    const column = title.parentElement as HTMLElement;
    expect(column).toHaveClass('mx-auto', 'max-w-[900px]', 'px-6');
    expect(within(column).getByRole('button', { name: 'New task' })).toBeInTheDocument();
    expect(column.firstElementChild).toBe(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('status', { name: 'Loading' }).closest('.max-w-\\[900px\\]')).not.toBeNull();
    expect(screen.queryByText('What your agents are looking after')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    // Below `md` the shell's nav trigger is the only door to the sidebar.
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
    // No agent filter until there are rows from more than one agent.
    expect(screen.queryByRole('button', { name: 'Filter by agent' })).not.toBeInTheDocument();
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
    expect(groupHeadings()).toEqual(['Needs you 2', 'On track 1', 'No update yet 1']);

    // Each count is the rows under its own heading.
    const needsYou = screen.getByRole('region', { name: 'Needs you 2' });
    expect(within(needsYou).getAllByRole('listitem')).toHaveLength(2);
    expect(within(needsYou).getByText('Morning inbox')).toBeInTheDocument();
    expect(within(needsYou).getByText('Overdue invoices')).toBeInTheDocument();
    const noUpdate = screen.getByRole('region', { name: 'No update yet 1' });
    expect(within(noUpdate).getByText('Weekly digest')).toBeInTheDocument();
    // No summary strip: the headings are the only counts.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('collapses paused tasks behind an "N paused" toggle', async () => {
    tasksMock.mockResolvedValueOnce(
      page([
        row('Support queue', { task: report('needs-you') }),
        // Paused outranks whatever the last report said.
        row('Old inbox', { enabled: false, task: report('needs-you') }),
      ]),
    );
    const first = renderPage();
    await screen.findByText('Support queue');
    expect(groupHeadings()).toEqual(['Needs you 1']);
    expect(screen.queryByText('Old inbox')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: '1 paused task' });
    expect(toggle).toHaveTextContent('1 paused');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(within(screen.getByRole('list', { name: 'Paused tasks' })).getByText('Old inbox')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(groupHeadings()).toEqual(['Needs you 1']);
    // A paused row needs nobody, so it has no Reply.
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
    first.unmount();

    tasksMock.mockResolvedValueOnce(
      page([
        row('Old inbox', { enabled: false, task: report('needs-you') }),
        row('Old digest', { enabled: false }),
      ]),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: '2 paused tasks' })).toBeInTheDocument();
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
      'Needs you 1',
      'Off track 1',
      'No recent update 1',
      'On track 1',
    ]);
    const needsYou = screen.getByRole('region', { name: 'Needs you 1' });
    expect(within(needsYou).getByText('Weekly digest')).toBeInTheDocument();
    const quiet = screen.getByRole('region', { name: 'No recent update 1' });
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
    // "checked" dates the miss; the three-miss row needs you, so Reply stands in its place.
    expect(within(rowLink('Morning inbox')).getByText(/^Checked /)).toBeInTheDocument();
    expect(within(rowLink('Weekly digest')).queryByText(/^Checked /)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
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
    fireEvent.click(screen.getByRole('button', { name: '2 paused tasks' }));
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
    expect(screen.queryByText('Nothing is running right now.')).not.toBeInTheDocument();
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

  it('draws an ask with markdown or HTML as plain text, in quotes', async () => {
    const ASK = '<img src=x onerror=alert(1)> **Keep checking**, or pause?';
    tasksMock.mockResolvedValue(page([row('Inbox', { task: report('needs-you', { ask: ASK }) })]));
    const { container } = renderPage();
    const ask = await screen.findByTitle(ASK);
    expect(ask.textContent).toBe(`“${ASK}”`);
    expect(container.querySelector('ul img, ul strong')).toBeNull();
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
    expect(await screen.findByText('Checked 4 min ago')).toBeInTheDocument();
    expect(within(rowLink('Support queue')).getByText('4m')).toBeInTheDocument();
    const digest = rowLink('Weekly digest');
    expect(within(digest).getByText('Juniper').textContent).toBe('Juniper');
    expect(within(digest).queryByText(/^Checked /)).toBeNull();

    // A tab left open keeps counting instead of saying "4 min ago" forever.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('Checked 6 min ago')).toBeInTheDocument();
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
    expect(await screen.findByText('Checked 4 min ago')).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: '1 paused task' }));
    expect(screen.getByText('Checked 4 min ago')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('Checked 6 min ago')).toBeInTheDocument();
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

  it('each task opens its page, through a link named for the task', async () => {
    tasksMock.mockResolvedValue(
      page([row('Support queue', { routineId: 't1', task: report('needs-you') })]),
    );
    const { onNavigate } = renderPage();
    const link = await screen.findByRole('link', { name: /Support queue/ });
    expect(link).toHaveAttribute('href', '/workspace/tasks/a1/t1');
    // The name leads, then what the icons stand for, then whose task it is.
    expect(link).toHaveAccessibleName(/^Support queue .*Stay on top.*Caveman/);

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

  it('a needs-you row has a Reply button beside its link, never inside it', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', { routineId: 't1', task: report('needs-you', { ask: 'Keep checking, or pause?' }) }),
        row('Weekly digest', { task: report('on-track') }),
      ]),
    );
    const { onNavigate, onReply } = renderPage();
    // Reply takes the right-hand fact's place: the needs-you row has no "checked" time.
    await screen.findByText('Support queue');
    expect(within(rowLink('Support queue')).queryByText(/^Checked /)).toBeNull();
    expect(within(rowLink('Weekly digest')).getByText(/^Checked /)).toBeInTheDocument();
    const reply = await screen.findByRole('button', { name: 'Reply' });
    expect(reply).toHaveAccessibleDescription('Support queue');
    const link = rowLink('Support queue');
    expect(link.contains(reply)).toBe(false);
    expect(link.querySelector('button')).toBeNull();
    expect(reply.closest('li')).toBe(link.closest('li'));
    // The ask is the row's line, quoted, in the foreground.
    const ask = within(link).getByText('“Keep checking, or pause?”');
    expect(ask).toHaveClass('text-foreground');
    expect(ask).toHaveAttribute('title', 'Keep checking, or pause?');
    expect(within(link).queryByText('Nothing new since this morning.')).toBeNull();

    // Reply opens the task with its reply box focused: the shell's own Reply, not a plain visit.
    fireEvent.click(reply);
    expect(onReply).toHaveBeenCalledWith({ kind: 'task', agentId: 'a1', routineId: 't1' });
    expect(onNavigate).not.toHaveBeenCalled();
    // Only the row that needs you gets one.
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
    expect(within(rowLink('Weekly digest')).getByText('Nothing new since this morning.')).toHaveClass(
      'text-muted-foreground',
    );
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
    expect(await screen.findByText('2 of 5 steps')).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.queryByText(/checked/i)).toBeNull();
    expect(screen.getByRole('link', { name: /Get something done/ })).toBeInTheDocument();
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
    expect(await screen.findByText('Checked 4 min ago')).toBeInTheDocument();
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
    expect(await screen.findAllByText('2 of 5 steps · 9 days left')).toHaveLength(1);
    expect(within(rowLink('Nine')).getByText('2/5 · Oct 31')).toBeInTheDocument();
    expect(screen.getByText('2 of 5 steps · Due today')).toBeInTheDocument();
    const late = screen.getByText('2 of 5 steps · 3 days past its finish date');
    // Past its date is the one fact drawn in the error colour (with its words, never colour alone).
    expect(late.parentElement).toHaveClass('text-destructive');
    expect(within(rowLink('No steps, never reported')).getByText('9 days left')).toBeInTheDocument();
    expect(screen.getByText('Checked 4 min ago · 9 days left')).toBeInTheDocument();
    expect(within(rowLink('Undated')).getByText('2 of 5 steps')).toBeInTheDocument();
    // The stay-on-top row has no fact at all: just its agent's name.
    const stay = rowLink('Stay on top');
    expect(within(stay).getByText('Caveman')).toBeInTheDocument();
    expect(within(stay).queryByText(/left|Due|Checked/)).toBeNull();
  });
});

describe('TasksPage: the latest line', () => {
  it('keeps the agent’s reading out of the row (TASK-952: the task page shows it)', async () => {
    tasksMock.mockResolvedValue(
      page([row('Support queue', { task: report('on-track', { reading: { label: 'Open tickets', value: 3 } }) })]),
    );
    renderPage();
    await screen.findByText('Nothing new since this morning.');
    expect(screen.queryByText(/reading/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open tickets/)).not.toBeInTheDocument();
  });

  it('a row whose update fenced to nothing shows no line', async () => {
    tasksMock.mockResolvedValue(page([row('Support queue', { task: report('on-track', { update: null }) })]));
    renderPage();
    await screen.findByText('Support queue');
    // The name is the one clamped line left.
    expect(rowLink('Support queue').querySelectorAll('span.truncate')).toHaveLength(1);
  });
});

describe('TasksPage: agent filter', () => {
  it('is hidden while every row is one agent’s', async () => {
    tasksMock.mockResolvedValue(page([row('Support queue'), row('Weekly digest')]));
    renderPage();
    await screen.findByText('Support queue');
    expect(screen.queryByRole('button', { name: 'Filter by agent' })).not.toBeInTheDocument();
  });

  it('narrows the rows to one agent, and All agents brings them back', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', { task: report('needs-you') }),
        row('Weekly digest', { agentId: 'a2', agentName: 'Juniper', task: report('on-track') }),
        row('Old inbox', { agentId: 'a2', agentName: 'Juniper', enabled: false }),
      ]),
    );
    renderPage();
    await screen.findByText('Support queue');
    const filter = screen.getByRole('button', { name: 'Filter by agent' });
    expect(filter.querySelector('svg.lucide-bot')).not.toBeNull();
    fireEvent.pointerDown(filter, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual([
      'All agents',
      'Caveman',
      'Juniper',
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'All agents' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Juniper' }));

    await waitFor(() => expect(screen.queryByText('Support queue')).not.toBeInTheDocument());
    expect(groupHeadings()).toEqual(['On track 1']);
    expect(screen.getByText('Weekly digest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 paused task' })).toBeInTheDocument();
    // The filter button says it is on, by name, and wears the agent's tile in place of the Bot.
    expect(screen.queryByRole('button', { name: 'Filter by agent' })).not.toBeInTheDocument();
    const on = screen.getByRole('button', { name: 'Showing Juniper’s tasks. Change filter' });
    expect(on).toHaveTextContent('Ju');
    expect(on.querySelector('svg.lucide-bot')).toBeNull();
    expect(screen.queryByText('Showing Juniper’s tasks.')).not.toBeInTheDocument();

    // All agents is still first, the current choice is checked, and picking All agents clears it.
    fireEvent.pointerDown(on, { button: 0, ctrlKey: false });
    const again = await screen.findByRole('menu');
    const items = within(again).getAllByRole('menuitemradio');
    expect(items[0]).toHaveTextContent('All agents');
    expect(within(again).getByRole('menuitemradio', { name: 'Juniper' })).toHaveAttribute('aria-checked', 'true');
    expect(items[0]).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(items[0]!);
    await waitFor(() => expect(groupHeadings()).toEqual(['Needs you 1', 'On track 1']));
    expect(screen.getByRole('button', { name: 'Filter by agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Showing / })).not.toBeInTheDocument();
  });
});

describe('TasksPage: Done tasks (TASK-950)', () => {
  const NOW_MS = Date.parse('2026-10-24T12:00:00Z');
  const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const CALM = 'Nothing is running right now.';

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

  const openDone = (count: number) =>
    fireEvent.click(screen.getByRole('button', { name: `${count} done ${count === 1 ? 'task' : 'tasks'}` }));

  it('the groups come first, then the paused and done toggles; no "Done this week" section', async () => {
    tasksMock.mockResolvedValue(
      page([
        row('Support queue', { task: report('on-track') }),
        done('Tidy the garage', ago(2 * HOUR)),
        row('Old inbox', { enabled: false }),
      ]),
    );
    renderPage();
    await screen.findByText('Support queue');
    expect(groupHeadings()).toEqual(['On track 1']);
    expect(screen.queryByText('Tidy the garage')).not.toBeInTheDocument();

    const onTrack = screen.getByRole('region', { name: 'On track 1' });
    const paused = screen.getByRole('button', { name: '1 paused task' });
    const doneToggle = screen.getByRole('button', { name: '1 done task' });
    expect(doneToggle).toHaveTextContent('1 done');
    expect(after(onTrack, paused)).toBeTruthy();
    expect(after(paused, doneToggle)).toBeTruthy();

    // A done row names when it finished, and still shows the agent's last update.
    openDone(1);
    expect(doneToggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Done tasks' });
    expect(within(list).getByText(/^Done (at |yesterday at |tomorrow at |on )/)).toBeInTheDocument();
    expect(within(list).getByText('Tidy the garage is finished.')).toBeInTheDocument();
    // Its claim is settled: no Reply, and no "Thinks it's done".
    expect(within(list).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(within(list).queryByText('Thinks it’s done')).toBeNull();
  });

  it('a done row with a finish date counts no days left (TASK-951)', async () => {
    tasksMock.mockResolvedValue(
      page([done('Tidy the garage', ago(2 * HOUR), { finishBy: { date: '2026-10-31', daysLeft: 7 } })]),
    );
    renderPage();
    await screen.findByRole('button', { name: '1 done task' });
    openDone(1);
    expect(screen.getByText(/^Done (at |yesterday at |tomorrow at |on )/)).toBeInTheDocument();
    expect(screen.queryByText(/days? left|Due today|past its finish date/)).toBeNull();
  });

  it('a done row says only "Done" when its time cannot be read', async () => {
    tasksMock.mockResolvedValue(page([done('Tidy the garage', 'not a time')]));
    renderPage();
    await screen.findByRole('button', { name: '1 done task' });
    openDone(1);
    expect(within(screen.getByRole('list', { name: 'Done tasks' })).getByTitle('Done')).toBeInTheDocument();
  });

  it('the done toggle shows only when a task is done, and counts them', async () => {
    tasksMock.mockResolvedValueOnce(page([row('Support queue', { task: report('on-track') })]));
    const first = renderPage();
    await screen.findByText('Support queue');
    expect(screen.queryByRole('button', { name: /done/ })).not.toBeInTheDocument();
    first.unmount();

    tasksMock.mockResolvedValueOnce(
      page([done('One', ago(HOUR)), done('Two', ago(9 * DAY)), row('Support queue')]),
    );
    renderPage();
    await screen.findByText('Support queue');
    const toggle = screen.getByRole('button', { name: '2 done tasks' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('One')).not.toBeInTheDocument();
  });

  it('the done toggle lists every done task, newest first, and nothing else', async () => {
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
    await screen.findByText('Support queue');
    openDone(3);

    const list = screen.getByRole('list', { name: 'Done tasks' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => within(li).getByText(/^(Oldest|Newest|Middle)$/).textContent),
    ).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(within(list).queryByText('Support queue')).toBeNull();
    expect(within(list).queryByText('Old inbox')).toBeNull();
    // The groups are untouched by it.
    expect(groupHeadings()).toEqual(['Needs you 1']);

    fireEvent.click(screen.getByRole('button', { name: '3 done tasks' }));
    expect(screen.queryByText('Oldest')).not.toBeInTheDocument();
  });

  it('a task done 8 days ago is only behind the done toggle', async () => {
    tasksMock.mockResolvedValue(
      page([done('Last week', ago(8 * DAY)), row('Support queue', { task: report('on-track') })]),
    );
    renderPage();
    await screen.findByText('Support queue');
    expect(screen.queryByText('Last week')).not.toBeInTheDocument();
    expect(groupHeadings()).toEqual(['On track 1']);
    openDone(1);
    expect(screen.getByText('Last week')).toBeInTheDocument();
  });

  it('says nothing is running when nothing is, offering the paused tasks', async () => {
    tasksMock.mockResolvedValueOnce(page([done('Last week', ago(8 * DAY))]));
    const first = renderPage();
    await screen.findByRole('button', { name: '1 done task' });
    expect(screen.getByText(CALM)).toBeInTheDocument();
    // It is not the "no tasks yet" teaching: there are tasks.
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show \d+ paused$/ })).not.toBeInTheDocument();
    first.unmount();

    // With paused tasks it offers to show them, and opens the paused toggle in place.
    tasksMock.mockResolvedValueOnce(
      page([done('Last week', ago(8 * DAY)), row('Old inbox', { enabled: false }), row('Old digest', { enabled: false })]),
    );
    const second = renderPage();
    const show = await screen.findByRole('button', { name: 'Show 2 paused' });
    expect(screen.getByText(CALM)).toBeInTheDocument();
    expect(screen.queryByText('Old inbox')).not.toBeInTheDocument();
    fireEvent.click(show);
    expect(screen.getByText('Old inbox')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: '2 paused tasks' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: 'Show 2 paused' })).not.toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveFocus());
    second.unmount();

    // A task done this week doesn't hide it: closed toggles alone would look broken.
    tasksMock.mockResolvedValueOnce(
      page([done('Four days ago', ago(4 * DAY)), row('Old inbox', { enabled: false }), row('Old digest', { enabled: false })]),
    );
    const third = renderPage();
    await screen.findByRole('button', { name: '1 done task' });
    expect(screen.getByText(CALM)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 2 paused' })).toBeInTheDocument();
    third.unmount();
    tasksMock.mockResolvedValueOnce(page([done('This hour', ago(HOUR))]));
    const fourth = renderPage();
    await screen.findByRole('button', { name: '1 done task' });
    expect(screen.getByText(CALM)).toBeInTheDocument();
    fourth.unmount();

    // So is a running task, or a running Repeat job.
    tasksMock.mockResolvedValueOnce(
      page([row('Daily digest', { kind: 'repeat', repeat: { lastRunAt: null, status: null, error: null, warning: null, active: 0, waiting: 0, sharedThread: false, appUpdates: false } })]),
    );
    renderPage();
    await screen.findByText('Daily digest');
    expect(screen.queryByText(CALM)).not.toBeInTheDocument();
  });

  it('keeps the load alerts with the done list open', async () => {
    tasksMock.mockResolvedValue(page([done('Tidy the garage', ago(HOUR))], [JUNIPER]));
    renderPage();
    const note = 'We couldn’t load tasks from Juniper just now, so some may be missing.';
    expect(await screen.findByText(note)).toBeInTheDocument();
    openDone(1);
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('the done list stays open across a re-read, and goes when the last done task is reopened', () => {
    const supportQueue = () => row('Support queue', { task: report('on-track') });
    const pageFor = (tasks: TaskRow[]) => (
      <TasksPage onTaskWriteSucceeded={vi.fn()} state={ready(tasks)} retry={vi.fn()} onNavigate={vi.fn()} onReply={vi.fn()} />
    );
    const view = render(pageFor([done('Old one', ago(9 * DAY)), supportQueue()]));
    openDone(1);
    expect(screen.getByText('Old one')).toBeInTheDocument();

    // A re-read that still has done tasks stays open.
    view.rerender(pageFor([done('Old one', ago(9 * DAY)), done('New one', ago(HOUR)), supportQueue()]));
    expect(screen.getByRole('button', { name: '2 done tasks' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('New one')).toBeInTheDocument();

    // The last done task is reopened: no toggle.
    view.rerender(pageFor([row('Old one', { task: report('on-track') }), supportQueue()]));
    expect(groupHeadings()).toEqual(['On track 2']);
    expect(screen.queryByRole('button', { name: /done task/ })).not.toBeInTheDocument();

    // The next task marked done brings the toggle back closed: the page doesn't open it by itself.
    view.rerender(pageFor([done('Support queue', ago(HOUR)), row('Old one', { task: report('on-track') })]));
    expect(screen.getByRole('button', { name: '1 done task' })).toHaveAttribute('aria-expanded', 'false');
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
    expect(await screen.findByText('Checked 1 min ago')).toBeInTheDocument();
    expect(screen.queryByText(/checked 19 hr ago/i)).toBeNull();
  });
});


describe('TasksPage: claimed completion wording (TASK-959)', () => {
  it('a current claim is the row’s one line, while ordinary and Done rows do not say it', async () => {
    tasksMock.mockResolvedValue(page([
      row('Claimed', { kind: 'get-done', task: report('needs-you', { doneClaimed: true, update: 'All articles moved.' }) }),
      row('Ordinary', { task: report('needs-you') }),
      row('Finished', { enabled: false, kind: 'get-done', doneAt: new Date().toISOString(), task: report('needs-you', { doneClaimed: true }) }),
    ]));
    renderPage();
    await screen.findByText('Claimed');
    const claim = rowLink('Claimed');
    expect(within(claim).getByText('Thinks it’s done')).toBeVisible();
    // At most one latest line: the claim wins over the update.
    expect(within(claim).queryByText('All articles moved.')).toBeNull();
    expect(within(rowLink('Ordinary')).queryByText('Thinks it’s done')).toBeNull();
    openFinished();
    expect(within(rowLink('Finished')).queryByText('Thinks it’s done')).toBeNull();
  });

  it('keeps missed-check-in wording ahead of an old claim', async () => {
    tasksMock.mockResolvedValue(page([row('Missed', {
      kind: 'get-done',
      task: report('needs-you', { doneClaimed: true, update: 'Old update.' }),
      noRecentUpdate: { inARow: 3, reason: 'no-report', at: new Date().toISOString(), autoPaused: false },
    })]));
    renderPage();
    await screen.findByText('Missed');
    const link = rowLink('Missed');
    expect(link).toHaveTextContent('Its last 3 check-ins didn’t leave an update.');
    expect(within(link).queryByText('Thinks it’s done')).toBeNull();
    expect(within(link).queryByText('Old update.')).toBeNull();
  });
});

function openFinished() {
  fireEvent.click(screen.getByRole('button', { name: '1 done task' }));
}
