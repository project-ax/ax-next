/**
 * The Tasks page (TASK-909): every task the person owns, across the agents
 * they can see, grouped by what needs them.
 *
 * Driven through the REAL `useTasks` and the real page, with only the network
 * call mocked, so each case is what the reader would actually see. The copy is
 * asserted verbatim because it is decided (TASK-909 decisions row 11), and its
 * apostrophe is U+2019, not the ASCII one.
 */
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
import { TasksPage } from '../TasksPage';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { tasks: vi.fn() } };
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
    task: null,
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
  it('shows the title and subtitle while it loads', () => {
    tasksMock.mockReturnValue(new Promise<TasksResponse>(() => {}));
    render(<TasksPage leading={<button type="button">Open navigation</button>} />);
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
    render(<TasksPage />);
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
    const first = render(<TasksPage />);
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
    render(<TasksPage />);
    expect(await screen.findByRole('button', { name: 'Show 2 paused tasks' })).toBeInTheDocument();
    // Every task paused is still not "no tasks".
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });

  it('teaches the one way in when there are no tasks', async () => {
    tasksMock.mockResolvedValue(page([]));
    render(<TasksPage />);
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask an agent in chat to keep an eye on something for you, like an inbox or a queue.',
      ),
    ).toBeInTheDocument();
    expect(groupHeadings()).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Chat is the way in; PR 1 has no New task button.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says which agents could not be read, and never claims the list is empty', async () => {
    tasksMock.mockResolvedValueOnce(page([], [JUNIPER]));
    const first = render(<TasksPage />);
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
    render(<TasksPage />);
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

  it('draws an update with markdown or HTML as plain text', async () => {
    const UPDATE = '**Done** <b>3</b> [docs](https://x.test) <img src=x onerror=alert(1)>';
    const NAME = '**Weekly** <b>digest</b>';
    tasksMock.mockResolvedValue(
      page([row(NAME, { task: report('on-track', { update: UPDATE }) })]),
    );
    const { container } = render(<TasksPage />);
    const update = await screen.findByTitle(UPDATE);
    expect(update.textContent).toBe(UPDATE);
    expect(screen.getByTitle(NAME).textContent).toBe(NAME);
    expect(container.querySelector('ul strong, ul b, ul a, ul img')).toBeNull();
  });

  it('keeps the whole name and update in a title', async () => {
    const NAME =
      'Keep every enterprise customer’s support ticket under an hour, weekends included';
    const UPDATE = `${'Two invoices are three days old and one is waiting on Acme. '.repeat(8)}End.`;
    tasksMock.mockResolvedValue(page([row(NAME, { task: report('needs-you', { update: UPDATE }) })]));
    render(<TasksPage />);
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
    render(<TasksPage />);
    expect(await screen.findByText('Caveman · checked 4 min ago')).toBeInTheDocument();
    const digest = screen.getByText('Weekly digest').closest('li') as HTMLElement;
    expect(within(digest).getByText('Juniper').textContent).toBe('Juniper');

    // A tab left open keeps counting instead of saying "4 min ago" forever.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('Caveman · checked 6 min ago')).toBeInTheDocument();
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
    render(<TasksPage />);
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
    render(<TasksPage />);
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
    render(<TasksPage />);
    expect(await screen.findByText(HTTP_SESSION_ENDED)).toBeInTheDocument();
    // Signing in is not a repair, so the register is the default one.
    expect(screen.getByRole('alert').className).not.toContain('destructive');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
