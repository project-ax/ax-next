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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { todayQueue, type TodayGroup } from '@/lib/today-queue';
import { workspaceApi } from '@/lib/workspace-api';
import type { Decision, TaskRow, TaskRowReport } from '@/lib/workspace-types';
import { TodayTaskGroup } from '../TodayTaskGroup';
import { decisionFixture, resolvedFixture } from './decision-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { sendTaskReply: vi.fn() } };
});

const sendMock = vi.mocked(workspaceApi.sendTaskReply);

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
    task: null,
    noRecentUpdate: null,
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
