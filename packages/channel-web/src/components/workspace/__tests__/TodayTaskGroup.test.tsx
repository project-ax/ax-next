/**
 * TodayTaskGroup: one task's block on Today (TASK-933).
 *
 * Every block here is built by the real `todayQueue` from a task row and its
 * approvals, so each case draws what Today would hand the component. Only
 * `sendTaskReply` is mocked. The copy is asserted verbatim because the plan
 * pins it: apostrophes are U+2019, the separator is U+00B7.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { todayQueue, type TodayGroup } from '@/lib/today-queue';
import { WorkspaceApiError, workspaceApi } from '@/lib/workspace-api';
import type { Decision, TaskRow, TaskRowReport } from '@/lib/workspace-types';
import { MARK_DONE_NOT_ALLOWED } from '../TaskMarkDone';
import { CANT_SHOW } from '../TaskPage';
import { TodayTaskGroup } from '../TodayTaskGroup';
import { decisionFixture, resolvedFixture } from './decision-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: { sendTaskReply: vi.fn(), completeTask: vi.fn(), reopenTask: vi.fn() },
  };
});

const sendMock = vi.mocked(workspaceApi.sendTaskReply);
const completeMock = vi.mocked(workspaceApi.completeTask);
const reopenMock = vi.mocked(workspaceApi.reopenTask);

const NAME = 'Zero open support tickets';
const LABEL = { routineId: 't1', taskName: NAME };
const BOX = 'Reply to Caveman about this task';

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'a1',
    agentName: 'Caveman',
    routineId: 't1',
    name: NAME,
    enabled: true,
    kind: 'stay-on-top',
    steps: null,
    finishBy: null,
    task: null,
    noRecentUpdate: null,
    doneAt: null,
    ...over,
  };
}

function report(
  status: TaskRowReport['status'],
  over: Partial<TaskRowReport> = {},
): TaskRowReport {
  return {
    status,
    update: 'Two tickets are still open.',
    ask: null,
    reading: null,
    doneClaimed: false,
    reportedAt: '2026-10-23T10:00:00.000Z',
    ...over,
  };
}

type Misses = NonNullable<TaskRow['noRecentUpdate']>;

function misses(inARow: number, over: Partial<Misses> = {}): Misses {
  return { inARow, reason: 'no-report', at: '2026-10-23T11:00:00.000Z', autoPaused: false, ...over };
}

/** An approval held during one of t1's check-ins. */
function approval(id: string, over: Partial<Decision> = {}): Decision {
  return decisionFixture({ id, agentId: 'a1', checkIn: LABEL, ...over });
}

/** t1's block, as `todayQueue` builds it for Today. */
function group(tasks: TaskRow[], decisions: Decision[] = []): TodayGroup {
  const { groups } = todayQueue({
    tasks,
    decisions,
    agents: [{ id: 'a1', name: 'Caveman' }],
    now: Date.now(),
  });
  const [only, ...rest] = groups;
  if (only === undefined || rest.length > 0) {
    throw new Error(`expected one block, got ${groups.length}`);
  }
  return only;
}

function renderGroup(g: TodayGroup, children?: ReactNode) {
  const onNavigate = vi.fn();
  const onReplied = vi.fn();
  const view = render(
    <TodayTaskGroup group={g} onNavigate={onNavigate} onReplied={onReplied}>
      {children}
    </TodayTaskGroup>,
  );
  return { ...view, onNavigate, onReplied };
}

/** A task whose agent's last report said Needs you, asking `ask`. */
function asking(ask: string | null = 'Want me to draft a reply to #4410?'): TaskRow {
  return row({ task: report('needs-you', { ask }) });
}

beforeEach(() => {
  sendMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('TodayTaskGroup (TASK-933)', () => {
  it('a task whose agent asked shows the ask as written, with Reply and Open task', () => {
    const { onNavigate } = renderGroup(group([asking()]));
    const block = screen.getByRole('group', { name: /Zero open support tickets\s*, needs you/ });
    // A labelled group, not a landmark: Today can hold many blocks, and each
    // one in the landmark list would bury the page's own (TASK-933 review).
    expect(screen.queryByRole('region')).toBeNull();
    // The mark is aria-hidden; the state word is for assistive tech only.
    expect(within(block).getByText(', needs you')).toHaveClass('sr-only');
    expect(within(block).getByText('Task · Caveman')).toBeInTheDocument();
    expect(within(block).getByText('Want me to draft a reply to #4410?')).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    const link = within(block).getByRole('link', { name: /^Open task/ });
    expect(link).toHaveAttribute('href', '/workspace/tasks/a1/t1');
    // jsdom has no navigation: stop the browser default so the log stays clean.
    const stopNavigation = (e: Event) => e.preventDefault();
    link.addEventListener('click', stopNavigation);
    fireEvent.click(link, { ctrlKey: true });
    link.removeEventListener('click', stopNavigation);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', agentId: 'a1', routineId: 't1' });
  });

  it("shows the update when there's no ask, and says so when neither can be shown", () => {
    const first = renderGroup(group([asking(null)]));
    expect(screen.getByText('Two tickets are still open.')).toBeInTheDocument();
    first.unmount();

    const second = renderGroup(group([row({ task: report('needs-you', { update: null }) })]));
    expect(screen.getByText('It left an update we can’t show.')).toBeInTheDocument();
    second.unmount();

    // Blank text is nothing to show, as the task page reads an update.
    renderGroup(group([row({ task: report('needs-you', { ask: '', update: '' }) })]));
    expect(screen.getByText('It left an update we can’t show.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('the reply box is closed until Reply, and keeps what was typed when closed again', () => {
    renderGroup(group([asking()]));
    const reply = screen.getByRole('button', { name: 'Reply' });
    // Hidden content is out of the accessibility tree.
    expect(screen.queryByRole('textbox', { name: BOX })).toBeNull();
    expect(reply).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(reply);
    expect(reply).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: BOX }), { target: { value: 'Draft it' } });

    fireEvent.click(reply);
    expect(screen.queryByRole('textbox', { name: BOX })).toBeNull();
    expect(reply).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(reply);
    expect(screen.getByRole('textbox', { name: BOX })).toHaveValue('Draft it');
  });

  it('Reply opens the box in place, focused, and a sent reply tells Today to look again', async () => {
    sendMock.mockResolvedValue({ checkIn: 'started' });
    const { onReplied } = renderGroup(group([asking()]));
    const block = screen.getByRole('group', { name: /Zero open support tickets/ });

    fireEvent.click(within(block).getByRole('button', { name: 'Reply' }));
    const box = within(block).getByRole('textbox', { name: BOX });
    expect(box).toBeVisible();
    expect(document.activeElement).toBe(box);

    fireEvent.change(box, { target: { value: 'Yes, draft it' } });
    fireEvent.click(within(block).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledWith('a1', 't1', {
      text: 'Yes, draft it',
      requestId: expect.any(String),
    });
    expect(within(block).getByText('Sent. Caveman started checking in.')).toBeInTheDocument();
  });

  it("the box never promises a check-in Today can't vouch for", () => {
    renderGroup(group([asking()]));
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('textbox', { name: BOX })).toHaveAccessibleDescription(
      'Caveman reads your replies every time it checks in.',
    );
    expect(screen.queryByText(/starts a check-in/)).toBeNull();
  });

  it('three misses in a row: the count and the reason, Open task, no Reply', () => {
    // An on-track report's ask isn't a person being waited on.
    renderGroup(
      group([
        row({
          task: report('on-track', { ask: 'Should I watch the billing queue too?' }),
          noRecentUpdate: misses(3, { reason: 'brief-too-long' }),
        }),
      ]),
    );
    const block = screen.getByRole('group', { name: /Zero open support tickets\s*, needs you/ });
    expect(
      within(block).getByText(
        'Its last 3 check-ins didn’t leave an update. Its instructions are too long to load.',
      ),
    ).toBeInTheDocument();
    expect(within(block).getByRole('link', { name: /^Open task/ })).toHaveAttribute(
      'href',
      '/workspace/tasks/a1/t1',
    );
    expect(within(block).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByLabelText(BOX)).toBeNull();
    expect(screen.queryByText(/billing queue/)).toBeNull();
  });

  it("three misses don't hide a pending ask", () => {
    renderGroup(
      group([
        row({
          task: report('needs-you', { ask: 'Which view should I count?' }),
          noRecentUpdate: misses(3),
        }),
      ]),
    );
    const block = screen.getByRole('group', { name: /Zero open support tickets\s*, needs you/ });
    const miss = within(block).getByText(
      'Its last 3 check-ins didn’t leave an update. It checked in but didn’t say how it went.',
    );
    const ask = within(block).getByText('Caveman asks: Which view should I count?');
    expect(miss.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(block).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('three misses after a Needs you report with no ask keep its words and Reply (TASK-933 review)', () => {
    const first = renderGroup(
      group([row({ task: report('needs-you', { ask: null }), noRecentUpdate: misses(3) })]),
    );
    const block = screen.getByRole('group', { name: /Zero open support tickets\s*, needs you/ });
    const miss = within(block).getByText(
      'Its last 3 check-ins didn’t leave an update. It checked in but didn’t say how it went.',
    );
    const said = within(block).getByText('Caveman said: Two tickets are still open.');
    expect(said).toHaveClass('text-muted-foreground');
    expect(miss.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(block).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    first.unmount();

    // Neither an ask nor an update it can show: say so, and still offer Reply.
    // Not "It left an update we can’t show.": right after "didn’t leave an
    // update", that reads as a contradiction (TASK-933 review round 2).
    const second = renderGroup(
      group([
        row({ task: report('needs-you', { ask: '', update: null }), noRecentUpdate: misses(3) }),
      ]),
    );
    expect(
      screen.getByText('Caveman said it needs you before this, but we can’t show what it said.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('It left an update we can’t show.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    second.unmount();

    // Auto-paused: the same, and the box says when it'll be read.
    renderGroup(
      group([
        row({
          enabled: false,
          task: report('needs-you', { ask: null }),
          noRecentUpdate: misses(5, { autoPaused: true }),
        }),
      ]),
    );
    expect(screen.getByText('Caveman said: Two tickets are still open.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('textbox', { name: BOX })).toHaveAccessibleDescription(
      'It’s paused, so Caveman will read this once it’s resumed.',
    );
  });

  it('auto-paused: says why it stopped, with the paused mark', () => {
    const first = renderGroup(
      group([
        row({
          enabled: false,
          task: report('on-track'),
          noRecentUpdate: misses(5, { autoPaused: true }),
        }),
      ]),
    );
    const block = screen.getByRole('group', { name: /Zero open support tickets\s*, paused/ });
    expect(
      within(block).getByText('Paused after 5 check-ins in a row didn’t leave an update.'),
    ).toBeInTheDocument();
    expect(within(block).getByRole('link', { name: /^Open task/ })).toBeInTheDocument();
    expect(within(block).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByLabelText(BOX)).toBeNull();
    first.unmount();

    renderGroup(
      group([
        row({
          enabled: false,
          task: report('needs-you', { ask: 'Which view should I count?' }),
          noRecentUpdate: misses(5, { autoPaused: true }),
        }),
      ]),
    );
    expect(screen.getByText('Caveman asks: Which view should I count?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('textbox', { name: BOX })).toHaveAccessibleDescription(
      'It’s paused, so Caveman will read this once it’s resumed.',
    );
  });

  it('a task there only for its approvals: its name, how many wait, and Open task', () => {
    const receipt = resolvedFixture('executed', { id: 'd3', agentId: 'a1', checkIn: LABEL });
    const first = renderGroup(group([], [approval('d1'), approval('d2'), receipt]));
    const block = screen.getByRole('group', { name: /^Zero open support tickets/ });
    expect(within(block).getByText('Task · Caveman')).toBeInTheDocument();
    expect(within(block).getByText('2 approvals waiting')).toBeInTheDocument();
    expect(within(block).getByRole('link', { name: /^Open task/ })).toHaveAttribute(
      'href',
      '/workspace/tasks/a1/t1',
    );
    expect(within(block).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('group', { name: /needs you|paused/ })).toBeNull();
    first.unmount();

    const second = renderGroup(group([], [approval('d1')]));
    expect(screen.getByText('1 approval waiting')).toBeInTheDocument();
    second.unmount();

    const third = renderGroup(group([], [receipt]));
    expect(screen.getByRole('group', { name: /^Zero open support tickets/ })).toBeInTheDocument();
    expect(screen.queryByText(/approvals? waiting/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    third.unmount();

    // A task its person paused: its approvals still sit under it, and nothing it asked shows.
    renderGroup(
      group(
        [row({ enabled: false, task: report('needs-you', { ask: 'Which view should I count?' }) })],
        [approval('d1')],
      ),
    );
    expect(screen.getByText('1 approval waiting')).toBeInTheDocument();
    expect(screen.queryByText(/Which view should I count/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('group', { name: /needs you|paused/ })).toBeNull();
  });

  it("draws the agent's words as text", () => {
    const ask = '<img src=x onerror=alert(1)> **Zero** _open_';
    const name = '<em>Zero</em> open **tickets**';
    const { container } = renderGroup(
      group([row({ name, task: report('needs-you', { ask }) })]),
    );
    const line = screen.getByText(ask);
    expect(line).toHaveAttribute('title', ask);
    const heading = screen.getByText(name);
    expect(heading).toHaveAttribute('title', name);
    expect(container.querySelector('img, strong, em')).toBeNull();
  });

  it('draws its approvals inside the block', () => {
    renderGroup(group([asking()], [approval('d1')]), <p>an approval</p>);
    const block = screen.getByRole('group', { name: /Zero open support tickets\s*, needs you/ });
    expect(within(block).getByText('an approval')).toBeInTheDocument();
  });

  it('draws the mark in the heading: needs you for an ask, paused when auto-paused, none for approvals only', () => {
    const dot = (heading: HTMLElement) => heading.querySelector('span[aria-hidden="true"]');

    const asked = renderGroup(group([asking()]));
    const askMark = dot(within(screen.getByRole('group', { name: /^Zero open support tickets/ })).getByRole('heading'));
    expect(askMark).toHaveClass('bg-warning');
    asked.unmount();

    const paused = renderGroup(
      group([row({ enabled: false, task: report('on-track'), noRecentUpdate: misses(5, { autoPaused: true }) })]),
    );
    const pausedMark = dot(within(screen.getByRole('group', { name: /^Zero open support tickets/ })).getByRole('heading'));
    expect(pausedMark).toHaveClass('bg-state-quiet');
    expect(pausedMark).not.toHaveClass('bg-warning');
    paused.unmount();

    renderGroup(group([], [approval('d1')]));
    expect(dot(within(screen.getByRole('group', { name: /^Zero open support tickets/ })).getByRole('heading'))).toBeNull();
  });

  it('a Reply box left open does not come back open for a later ask', () => {
    const noAsk = group([row({ task: report('on-track'), noRecentUpdate: misses(3) })]);
    const ask = group([asking()]);
    const onNavigate = vi.fn();
    const onReplied = vi.fn();
    const ui = (g: TodayGroup) => (
      <TodayTaskGroup group={g} onNavigate={onNavigate} onReplied={onReplied} />
    );
    const view = render(ui(ask));
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: BOX }));

    // A re-read drops the ask while the box is open, then a later read brings one back.
    view.rerender(ui(noAsk));
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    view.rerender(ui(ask));

    expect(screen.getByRole('button', { name: 'Reply' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: BOX })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('a task that thinks it’s done (TASK-950)', () => {
  const UPDATE = 'Every ticket is closed.';
  const ASK = 'Want me to stop checking in?';
  const NOT_YET = 'What’s left for Caveman to do?';
  const UNCONFIRMED =
    'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.';
  /** A report after `report()`'s: a newer claim. */
  const LATER = '2026-10-23T12:00:00.000Z';

  /** An enabled task whose latest report claimed done. */
  function claimed(over: Partial<TaskRow> = {}, rep: Partial<TaskRowReport> = {}): TaskRow {
    return row({
      kind: 'get-done',
      task: report('needs-you', { update: UPDATE, doneClaimed: true, ...rep }),
      ...over,
    });
  }

  beforeEach(() => {
    completeMock.mockReset();
    reopenMock.mockReset();
  });

  it('says it thinks the task is done, then the update, then the ask muted', () => {
    renderGroup(group([claimed({}, { ask: ASK })]));
    const block = screen.getByRole('group', { name: /Zero open support tickets/ });
    expect(block).toHaveTextContent(', needs you');
    expect(within(block).getByText('Caveman thinks this is done.')).toBeInTheDocument();
    expect(within(block).getByText(UPDATE)).toBeInTheDocument();
    expect(within(block).getByText(`Caveman asks: ${ASK}`)).toHaveClass('text-muted-foreground');
    expect(within(block).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(within(block).getByRole('link', { name: /Open task/ })).toBeInTheDocument();
  });

  it('says so when the update can’t be shown', () => {
    renderGroup(group([claimed({}, { update: '' })]));
    expect(screen.getByText('Caveman thinks this is done.')).toBeInTheDocument();
    expect(screen.getByText(CANT_SHOW)).toBeInTheDocument();
  });

  it('Mark done and Not yet are both outline: Approve stays the one primary action', () => {
    renderGroup(group([claimed()]));
    for (const name of ['Mark done', 'Not yet']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).not.toContain('bg-action');
      expect(button.className).not.toContain('bg-primary');
    }
  });

  it('Mark done with nothing unticked finishes the task and tells Today to look again', async () => {
    completeMock.mockResolvedValue({ done: true });
    const { onReplied } = renderGroup(group([claimed()]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
    expect(completeMock).toHaveBeenCalledWith('a1', 't1', { requestId: expect.any(String) });
  });

  it('asks first when steps aren’t ticked, and says they stay as they are', async () => {
    completeMock.mockResolvedValue({ done: true });
    const { onReplied } = renderGroup(group([claimed({ steps: { done: 1, total: 3 } })]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(
      screen.getByText('2 steps aren’t ticked. They’ll stay on the task as they are.'),
    ).toBeInTheDocument();
    expect(completeMock).not.toHaveBeenCalled();
    // The confirmation takes the action row's place, and Mark done anyway is not primary here.
    expect(screen.queryByRole('button', { name: 'Not yet' })).toBeNull();
    const anyway = screen.getByRole('button', { name: 'Mark done anyway' });
    expect(anyway.className).not.toContain('bg-action');
    fireEvent.click(anyway);
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it('Not yet opens the box, and its Send reopens the task and tells Today to look again', async () => {
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    const { onReplied } = renderGroup(group([claimed()]));
    const block = screen.getByRole('group', { name: /Zero open support tickets/ });

    fireEvent.click(within(block).getByRole('button', { name: 'Not yet' }));
    const box = within(block).getByRole('textbox', { name: NOT_YET });
    expect(box).toBeVisible();
    expect(document.activeElement).toBe(box);

    fireEvent.change(box, { target: { value: 'Two are still open' } });
    fireEvent.click(within(block).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
    expect(reopenMock).toHaveBeenCalledWith('a1', 't1', {
      text: 'Two are still open',
      requestId: expect.any(String),
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('after Not yet the block stays, as after a Reply, and its box keeps its own words', async () => {
    reopenMock.mockResolvedValue({ checkIn: 'started' });
    const onNavigate = vi.fn();
    const onReplied = vi.fn();
    const ui = (g: TodayGroup) => (
      <TodayTaskGroup group={g} onNavigate={onNavigate} onReplied={onReplied} />
    );
    const view = render(ui(group([claimed()])));
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    fireEvent.change(screen.getByRole('textbox', { name: NOT_YET }), {
      target: { value: 'Two are still open' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));

    // Today reads the tasks again: the claim is taken back, and the report still says Needs you.
    view.rerender(ui(group([claimed({}, { doneClaimed: false })])));
    expect(screen.queryByText('Caveman thinks this is done.')).toBeNull();
    expect(screen.getByRole('textbox', { name: NOT_YET })).toBeVisible();
    expect(screen.getByRole('status').textContent).toBe('Sent. Caveman is checking in now.');
    const reply = screen.getByRole('button', { name: 'Reply' });
    expect(reply).toHaveAttribute('aria-expanded', 'true');

    // Opened again, the box answers what the block shows now.
    fireEvent.click(reply);
    fireEvent.click(reply);
    expect(screen.getByRole('textbox', { name: BOX })).toBeVisible();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a refused Mark done says why, under the row, and keeps the block', async () => {
    completeMock.mockRejectedValue(new WorkspaceApiError('/x', 403));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { onReplied } = renderGroup(group([claimed()]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText(MARK_DONE_NOT_ALLOWED)).toBeInTheDocument();
    expect(onReplied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled();
  });

  /**
   * Presses `button` with the answer held, drops focus on `<body>` as a browser does from a button
   * that goes disabled, then fails the press. jsdom keeps focus on a disabled button (its `blur()`
   * does nothing there), so a decoy takes focus and leaves the document (TaskPage.test's
   * `dropFocusOnBody`).
   */
  async function failWhileBusy(button: HTMLElement, status: number) {
    let fail!: (e: unknown) => void;
    completeMock.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => button.focus());
    fireEvent.click(button);
    expect(button).toBeDisabled();
    const decoy = document.createElement('button');
    document.body.append(decoy);
    act(() => decoy.focus());
    act(() => decoy.remove());
    expect(document.activeElement).toBe(document.body);
    await act(async () => fail(new WorkspaceApiError('/x', status)));
    await waitFor(() => expect(button).toBeEnabled());
  }

  it('a failed Mark done puts focus back on the button', async () => {
    renderGroup(group([claimed()]));
    const button = screen.getByRole('button', { name: 'Mark done' });
    await failWhileBusy(button, 503);
    expect(
      screen.getByText(
        'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.',
      ),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(button);
  });

  it('after an unconfirmed Mark done, a claim that goes and comes back is a new press', async () => {
    const ui = (g: TodayGroup) => (
      <TodayTaskGroup group={g} onNavigate={vi.fn()} onReplied={vi.fn()} />
    );
    const view = render(ui(group([claimed()])));
    await failWhileBusy(screen.getByRole('button', { name: 'Mark done' }), 502);
    // Not yet (here, or on the task page) took the claim back; later the agent claims again.
    view.rerender(ui(group([claimed({}, { doneClaimed: false })])));
    view.rerender(ui(group([claimed()])));
    expect(
      screen.queryByText(
        'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.',
      ),
    ).toBeNull();
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2].requestId).not.toBe(completeMock.mock.calls[0]![2].requestId);
  });

  it('after an unconfirmed Mark done anyway, a claim that goes and comes back asks afresh', async () => {
    const ui = (g: TodayGroup) => (
      <TodayTaskGroup group={g} onNavigate={vi.fn()} onReplied={vi.fn()} />
    );
    const steps = { done: 1, total: 3 };
    const view = render(ui(group([claimed({ steps })])));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await failWhileBusy(screen.getByRole('button', { name: 'Mark done anyway' }), 502);
    view.rerender(ui(group([claimed({ steps }, { doneClaimed: false })])));
    view.rerender(ui(group([claimed({ steps }, { reportedAt: LATER })])));
    // The old question doesn't come back with the new claim: it takes focus when it opens, and
    // its Mark done anyway is one Enter from finishing the task.
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done anyway' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2].requestId).not.toBe(completeMock.mock.calls[0]![2].requestId);
  });

  it('after an unconfirmed Mark done, a newer claim on the next read is a new press', async () => {
    const ui = (g: TodayGroup) => (
      <TodayTaskGroup group={g} onNavigate={vi.fn()} onReplied={vi.fn()} />
    );
    const view = render(ui(group([claimed()])));
    await failWhileBusy(screen.getByRole('button', { name: 'Mark done' }), 502);
    // Between two reads the claim was taken back and the agent claimed again: still a claim,
    // but not the one the press answered.
    view.rerender(ui(group([claimed({}, { update: 'All of them are closed.', reportedAt: LATER })])));
    expect(screen.queryByText(UNCONFIRMED)).toBeNull();
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2].requestId).not.toBe(completeMock.mock.calls[0]![2].requestId);
  });

  it('after an unconfirmed Mark done, a read showing the same claim keeps the press', async () => {
    const ui = (g: TodayGroup) => (
      <TodayTaskGroup group={g} onNavigate={vi.fn()} onReplied={vi.fn()} />
    );
    const view = render(ui(group([claimed()])));
    await failWhileBusy(screen.getByRole('button', { name: 'Mark done' }), 502);
    // Today reads the tasks again, and this one hasn't changed: a retry is the same request.
    view.rerender(ui(group([claimed()])));
    expect(screen.getByText(UNCONFIRMED)).toBeInTheDocument();
    completeMock.mockResolvedValue({ done: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    expect(completeMock.mock.calls[1]![2]).toEqual(completeMock.mock.calls[0]![2]);
  });

  it('a failed Mark done anyway puts focus back inside the question', async () => {
    renderGroup(group([claimed({ steps: { done: 1, total: 3 } })]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    const anyway = screen.getByRole('button', { name: 'Mark done anyway' });
    await failWhileBusy(anyway, 500);
    expect(document.activeElement).toBe(anyway);
  });

  it('Cancel puts focus back on Mark done', () => {
    renderGroup(group([claimed({ steps: { done: 1, total: 3 } })]));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    act(() => cancel.focus());
    fireEvent.click(cancel);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mark done' }));
  });

  it('hands focus to Today’s consent region before the block leaves', async () => {
    completeMock.mockResolvedValue({ done: true });
    const onReplied = vi.fn();
    const g = group([claimed()]);
    render(
      <div data-consent-region="" tabIndex={-1} aria-label="Waiting on you">
        <TodayTaskGroup group={g} onNavigate={vi.fn()} onReplied={onReplied} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(screen.getByLabelText('Waiting on you'));
  });
});
