/**
 * Today is where a zero does the most damage, because it sits next to a green
 * tick. "0 agents working · 0 waiting on you" under a check mark reads as a
 * report on a healthy system — and the surface cannot even know it: without an
 * activity producer (`agent-activity:get` — TASK-498 moved the state word off
 * sandbox liveness, which stayed true through every warm idle gap), every agent
 * reads `resting` regardless of what it is actually doing. A number we cannot
 * back does not get rendered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, type Decision, type WorkspaceAgent } from '@/lib/workspace-api';
import type { TaskRow, TaskRowReport } from '@/lib/workspace-types';
import { TodayView } from '../TodayView';
import { decisionFixture } from './decision-fixture';
import {
  DECISION_READ_FAILED,
  DECISION_SESSION_EXPIRED,
} from '../decision-copy';
import { signInWithGoogle } from '../../../lib/auth';

// The Sign in button's only job is to start the one sign-in this app has. The
// real thing navigates the window, which a jsdom test cannot survive.
vi.mock('../../../lib/auth', () => ({
  signInWithGoogle: vi.fn(async () => undefined),
}));

// A task's block on Today sends its reply through the real API module; only
// that one call is replaced (TASK-933).
vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace-api')>(
    '@/lib/workspace-api',
  );
  return { ...actual, workspaceApi: { ...actual.workspaceApi, sendTaskReply: vi.fn() } };
});

const sendTaskReplyMock = vi.mocked(workspaceApi.sendTaskReply);

/** The reassuring green tick that must not sit over a row of zeros. */
const CHECK_ICON = 'svg[class*="check"]';

function agent(over: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
    ...over,
  };
}

/**
 * The queue's rows come from the SHARED fixture — see `decision-fixture.ts`.
 * A per-file copy would let this component and the two renderers drift apart
 * while every test still passed, each agreeing with its own invention.
 */
const decision = (over: Partial<Decision> = {}): Decision =>
  decisionFixture({
    id: 'd1',
    agentId: 'a-quill',
    attendance: 'attended',
    freshness: null,
    summary: 'Send the reply to Dana?',
    detail: 'It answers her question about the roof quote.',
    primaryLabel: 'Send it',
    secondaryLabel: 'Let me edit',
    ghostLabel: 'Leave it',
    approvedText: 'Quill sent the reply to Dana',
    dismissedText: 'You left the reply to Dana unsent',
    createdAt: new Date().toISOString(),
    ...over,
  });

function renderToday(
  over: Partial<React.ComponentProps<typeof TodayView>> = {},
) {
  return render(
    <TodayView
      decisions={[]}
      grants={[]}
      onGrantResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
      agents={[agent()]}
      filter="needs"
      expandedId={null}
      onExpand={vi.fn()}
      onOpenAgent={vi.fn()}
      onNavigate={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      onSeeActivity={vi.fn()}
      tasks={[]}
      tasksError={null}
      tasksRefreshing={false}
      unavailableTaskAgents={[]}
      onRetryTasks={vi.fn()}
      onReplied={vi.fn()}
      {...over}
    />,
  );
}

describe('the summary line', () => {
  it('renders no row of zeros, and no tick over one', () => {
    const { container } = renderToday();

    expect(container.textContent).not.toMatch(/0 agents working/);
    expect(container.textContent).not.toMatch(/0 waiting on you/);
    // Nothing positive to report → the whole line, tick included, is absent.
    expect(container.querySelector(CHECK_ICON)).toBeNull();
  });

  it('counts one agent in the singular', () => {
    const { container } = renderToday({ agents: [agent({ state: 'working' })] });
    // Positive control for the assertion above: with real signal the tick is
    // back, so its absence there means something.
    expect(container.querySelector(CHECK_ICON)).not.toBeNull();
    expect(screen.getByText(/1 agent working/)).toBeTruthy();
    expect(screen.queryByText(/1 agents working/)).toBeNull();
    // Still nothing waiting → that half stays off rather than reading "· 0".
    expect(screen.queryByText(/0 waiting/)).toBeNull();
  });

  it('pluralises past one', () => {
    renderToday({
      agents: [agent({ state: 'working' }), agent({ id: 'a2', state: 'working' })],
    });
    expect(screen.getByText(/2 agents working/)).toBeTruthy();
  });
});

describe('doneToday', () => {
  it('renders in the summary line when positive', () => {
    renderToday({ doneToday: 3 });
    expect(screen.getByText(/3 done today/)).toBeTruthy();
  });

  it('renders nothing when zero', () => {
    const { container } = renderToday({ doneToday: 0 });
    expect(container.textContent).not.toMatch(/done today/);
  });

  it('renders nothing when absent', () => {
    const { container } = renderToday();
    expect(container.textContent).not.toMatch(/done today/);
  });
});

describe('the empty queue', () => {
  it('orients a first-timer instead of repeating the headline', () => {
    renderToday();

    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    // The card slot used to say "Nothing needs you right now." — the same
    // sentence as the headline, two inches lower.
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
    expect(screen.getByText(/wants your OK on/)).toBeTruthy();
  });

  it('hides the "open a row" hint when there is nothing to open', () => {
    const { container } = renderToday();
    expect(container.textContent).not.toMatch(/Open a row/);
    // "line" read like a phone line; it is a row in a list.
    expect(container.textContent).not.toMatch(/Open a line/);
  });

  it('shows the hint, in plain words, once there is a row', () => {
    renderToday({ decisions: [decision()] });

    expect(screen.getByText(/Open a row to see the detail/)).toBeTruthy();
  });
});

/*
  An empty queue is the most reassuring claim this page makes. It is only ever
  true when we managed to READ the queue — and a failed read looks exactly like
  an empty one from the outside, which is what makes this the worst place on the
  whole surface to be quietly wrong (design H7).
*/
describe('a queue we could not read', () => {
  it('never says nothing is waiting on you', () => {
    const { container } = renderToday({
      error: { kind: 'failed', detail: 'workspace /decisions → 503' },
    });

    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
    expect(
      screen.getByText('We could not check what is waiting on you.'),
    ).toBeTruthy();
    // And not the first-timer orientation either — that is the empty state,
    // and this is not empty, it is unknown.
    expect(container.textContent).not.toMatch(/wants your OK on/);
  });

  it('offers a way to try again', () => {
    const onRetry = vi.fn();
    renderToday({
      error: { kind: 'failed', detail: 'workspace /decisions → 503' },
      onRetry,
    });

    const retry = screen.getByRole('button', { name: 'Try again' });
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(DECISION_READ_FAILED)).toBeTruthy();
  });

  /*
    This page printed the thrown message in mono under the alert, so a person
    read "workspace /decisions → 401": a request path and a status code standing
    in for a sentence — on the one screen whose own comment already forbade
    internal identifiers and raw request paths.
  */
  it('never prints the thrown message at the reader', () => {
    const { container } = renderToday({
      error: { kind: 'failed', detail: 'workspace /decisions → 503' },
      onRetry: vi.fn(),
    });

    expect(container.textContent).not.toContain('workspace /decisions');
    expect(container.textContent).not.toContain('503');
  });

  it('does not count rows it could not read into the summary line', () => {
    const { container } = renderToday({
      error: { kind: 'failed', detail: 'boom' },
      decisions: [decision(), decision({ id: 'd2' })],
    });
    expect(container.textContent).not.toMatch(/waiting on you\b.*\d/);
  });
});

/*
  A 401 is not a blip, and the difference is the whole of TASK-276. The read was
  not lost, it was REFUSED — the session ran out — so "try again" is a button
  that returns the same 401 for as long as anyone is willing to press it. The
  only thing that moves is signing in, so that is the only thing offered.
*/
describe('a queue we were not allowed to read', () => {
  const expired = { kind: 'expired', detail: 'workspace /decisions → 401' } as const;

  it('says the reader is signed out rather than that something went wrong', () => {
    renderToday({ error: expired, onRetry: vi.fn() });

    expect(screen.getByText(DECISION_SESSION_EXPIRED)).toBeTruthy();
    expect(screen.queryByText(DECISION_READ_FAILED)).toBeNull();
  });

  it('offers sign-in and NOT a retry that cannot work', () => {
    // `onRetry` is supplied, so the retry button's absence is the branch's
    // doing and not a missing handler.
    renderToday({ error: expired, onRetry: vi.fn() });

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    screen.getByRole('button', { name: 'Sign in' }).click();
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('still never prints the thrown message at the reader', () => {
    const { container } = renderToday({ error: expired });
    expect(container.textContent).not.toContain('workspace /decisions');
    expect(container.textContent).not.toContain('401');
  });

  /*
    Red is a claim too. `destructive` reads "something has gone wrong", which is
    true of a blip and false of a session that ran out. The in-thread card draws
    THIS sentence — the signed-out one — neutral as well, so the two surfaces
    agree here.

    The comparison stops at the signed-out sentence, and that is the part
    TASK-290 corrected. This comment used to claim red would put the page in a
    "different register from the in-thread card" full stop; for a BLIP that is
    no longer true. The in-thread card is neutral only while an automatic
    attempt is genuinely still coming, and goes `destructive` once the retry
    budget is spent — the same register this page uses on its first failure,
    because `useDecisionQueue` has no automatic retry to wait on. `expired` is
    the axis where the two agree unconditionally. See `lib/read-register.ts`.

    Both halves are pinned, so deleting the branch fails one of them whichever
    way it is deleted.
  */
  it('does not dress a signed-out session up as something going wrong', () => {
    renderToday({ error: expired });
    expect(screen.getByRole('alert').className).not.toContain('destructive');
  });

  it('and a read that really did fail still reads as a failure', () => {
    renderToday({ error: { kind: 'failed', detail: 'boom' } });
    expect(screen.getByRole('alert').className).toContain('destructive');
  });

  it('still refuses to claim nothing is waiting on you', () => {
    renderToday({ error: expired, decisions: [decision()] });
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
  });
});

describe('the first read, before it lands', () => {
  it('does not flash the empty-queue claim while it is still checking', () => {
    renderToday({ loading: true });
    expect(screen.getByText(/Checking what is waiting on you/)).toBeTruthy();
    expect(screen.queryByText(/wants your OK on/)).toBeNull();
  });
});

describe('resolved rows', () => {
  it('keeps a just-resolved row on screen so its receipt lands where the click did', () => {
    renderToday({
      decisions: [
        decision({
          status: 'executed',
          resolvedAt: new Date().toISOString(),
          undoable: true,
        }),
      ],
    });
    expect(screen.getByText('Quill sent the reply to Dana')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('drops one resolved long enough ago that nobody is still looking at it', () => {
    const { container } = renderToday({
      decisions: [
        decision({
          status: 'executed',
          resolvedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ],
    });
    expect(container.textContent).not.toContain('Quill sent the reply to Dana');
  });
});

/*
  TASK-350 — the queue holds two kinds of thing now, and the heading counts
  both.

  These cases did not exist before. The populated headline was untested: only
  the zero case ("Nothing is waiting on you.") and the unreadable case had
  assertions, which is why the wording could be changed from "One decision" to
  "One thing" with the whole suite still green. A heading that is allowed to lie
  about a third of what it counts is exactly what this card exists to stop, so
  it gets covered here.
*/
const hostGrant = {
  key: 'host:example.org',
  agentId: 'a-quill',
  conversationId: 'c1',
  request: { kind: 'host' as const, host: 'example.org', sessionId: 's-1' },
};
const skillGrant = {
  key: 'skill:linear',
  agentId: 'a-quill',
  conversationId: 'c1',
  request: {
    kind: 'skill' as const,
    skillId: 'linear',
    description: '',
    hosts: [],
    slots: [],
  },
};

describe('the heading counts grants as well as decisions', () => {
  it('says one thing when one decision is open', () => {
    renderToday({ decisions: [decision()] });

    expect(screen.getByText('One thing is waiting on you.')).toBeTruthy();
  });

  it('says one thing when the only thing open is a grant', () => {
    // Before TASK-350 this said "Nothing is waiting on you." over a row that
    // was plainly waiting on you — the queue could not see grants at all.
    renderToday({ grants: [hostGrant] });

    expect(screen.getByText('One thing is waiting on you.')).toBeTruthy();
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
  });

  it('adds them up when the queue holds one of each', () => {
    // The discriminating case: counting only decisions gives "One thing".
    renderToday({ decisions: [decision()], grants: [hostGrant] });

    expect(screen.getByText('Two things are waiting on you.')).toBeTruthy();
  });

  it('counts both in the summary line too', () => {
    const { container } = renderToday({
      decisions: [decision()],
      grants: [hostGrant, skillGrant],
    });

    expect(container.textContent).toMatch(/3 waiting on you/);
  });
});

describe('a grant in the queue', () => {
  it('renders as an answerable row', () => {
    renderToday({ grants: [hostGrant] });

    expect(screen.getByText('Allow access to example.org?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /just this once/i })).toBeTruthy();
  });

  it('suppresses the empty state — the list is not empty', () => {
    // "When an agent hits something it wants your OK on, it'll wait for you
    // here" printed UNDER the thing waiting for you here is the same class of
    // defect as the heading: a true-sounding sentence the screen disproves.
    renderToday({ grants: [hostGrant] });

    expect(screen.queryByText(/wait for you here/)).toBeNull();
  });

  it('sits above the decisions — a stopped agent outranks a held action', () => {
    const { container } = renderToday({
      decisions: [decision()],
      grants: [hostGrant],
    });

    const text = container.textContent ?? '';
    expect(text.indexOf('Allow access to example.org?')).toBeLessThan(
      text.indexOf('Send the reply to Dana?'),
    );
  });
});

/*
  TASK-350 review finding — a grant must outlive an unreadable decisions queue.

  The first cut of this change put `grants.map(...)` inside the container gated
  on `readable`, so a 401/503 on `GET /api/workspace/decisions` hid every open
  grant. That re-created the exact dead-end the card exists to remove — an agent
  stopped at the wall, a person who cannot answer, a turn going nowhere — and
  triggered it from an unrelated failure on a different route.

  Grants do not come from that fetch. They arrive on the turn stream and live in
  their own store, so a failed read says nothing about them.
*/
describe('a grant when the decisions queue cannot be read', () => {
  const unreadable = { kind: 'failed' as const, detail: 'workspace /decisions → 503' };
  const hostGrant = {
    key: 'host:example.org',
    agentId: 'a-quill',
    conversationId: 'c1',
    request: { kind: 'host' as const, host: 'example.org', sessionId: 's-1' },
  };

  it('still renders, and is still answerable', () => {
    renderToday({ error: unreadable, grants: [hostGrant] });

    expect(screen.getByText('Allow access to example.org?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /just this once/i })).toBeEnabled();
  });

  it('does not stop the page saying the decisions could not be read', () => {
    // Both claims are true at once and both are shown: we could not check for
    // decisions, and here is a grant we did not need to check for.
    renderToday({ error: unreadable, grants: [hostGrant] });

    expect(screen.getByText('We could not check what is waiting on you.')).toBeTruthy();
  });

  it('shows no hint over a queue with nothing expandable in it', () => {
    // The hint is about opening a row for its detail, and only a decision row
    // expands. Keyed on the grant count it printed "Open a row…" over rows that
    // are already open — and, before the gate was fixed, over no rows at all.
    renderToday({ error: unreadable, grants: [hostGrant] });

    expect(screen.queryByText(/Open a row to see the detail/)).toBeNull();
  });
});

/*
  TASK-436 — the working row's activity line is clamped to one line by CSS.
  jsdom has no CSS, so this asserts what is assertable: the whole line is on
  the element in `title`, and an agent with NOTHING to report gets no `title`
  at all rather than an empty tooltip.
*/
describe('a clamped activity line (TASK-436)', () => {
  it('keeps the whole line reachable in `title`', () => {
    const now =
      'Reading the EMEA regional breakdown and reconciling it against the Q3 purchase orders';
    renderToday({ filter: 'working', agents: [agent({ state: 'working', now })] });
    expect(screen.getByText(now).getAttribute('title')).toBe(now);
  });

  it('adds no empty `title` when there is nothing to say', () => {
    const { container } = renderToday({
      filter: 'working',
      agents: [agent({ state: 'working' })],
    });
    expect(container.querySelector('[title=""]')).toBeNull();
  });
});

describe("an expanded check-in row (TASK-932)", () => {
  it('a check-in’s approval opens its task from its block’s heading, the one Open task there (TASK-933)', () => {
    const onNavigate = vi.fn();
    renderToday({
      decisions: [
        decision({
          attendance: 'unattended',
          agentId: 'a-quill',
          checkIn: { routineId: 't1', taskName: 'Zero open support tickets' },
        }),
      ],
      expandedId: 'd1',
      onNavigate,
    });
    // The expanded row sits inside its task's block now, so TASK-932's own
    // link on it would be a second, identical Open task in one block. The one
    // link is the block's, outside the expanded row.
    const links = screen.getAllByRole('link', { name: /^Open task/ });
    expect(links).toHaveLength(1);
    const link = links[0]!;
    const block = screen.getByRole('region', { name: /Zero open support tickets/ });
    expect(block).toContainElement(link);
    const row = screen.getByTestId('decision-d1');
    expect(block).toContainElement(row);
    expect(row).not.toContainElement(link);
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'task', agentId: 'a-quill', routineId: 't1' });
  });
});

/*
  TASK-933 — Today is the one inbox for tasks too. A task that needs the person
  gets its own block, the approvals raised during its check-ins sit under it,
  and the headline counts the task and each approval once.
*/
const TASK_NAME = 'Zero open support tickets';
const ASK = 'Want me to draft a reply to #4410?';

function taskRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'a-quill',
    agentName: 'Quill',
    routineId: 't1',
    name: TASK_NAME,
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
    reportedAt: '2026-10-23T10:00:00.000Z',
    ...over,
  };
}

/** t1, whose agent's last report said Needs you and asked something. */
const needsYouTask = (): TaskRow => taskRow({ task: report('needs-you', { ask: ASK }) });

/** t2, on track: on Today only for the approvals raised in its check-ins. */
const onTrackTask = (): TaskRow =>
  taskRow({ routineId: 't2', name: 'Weekly invoice run', task: report('on-track') });

/** An approval held during one of `routineId`'s check-ins. */
const heldDuring = (routineId: string, taskName: string, over: Partial<Decision> = {}) =>
  decision({ attendance: 'unattended', checkIn: { routineId, taskName }, ...over });

const taskBlock = (name: RegExp = /Zero open support tickets/) =>
  screen.getByRole('region', { name });

/** The `Alert` carrying `sentence`, by its sentence: decision rows carry their own `role="alert"` live regions. */
function alertWith(sentence: string): HTMLElement {
  const box = screen.getByText(sentence).closest<HTMLElement>('[role="alert"]');
  expect(box).not.toBeNull();
  return box!;
}

const COULD_NOT_CHECK = 'We could not check what is waiting on you.';
const TASKS_FAILED = 'We couldn’t check your tasks just now.';

describe('what tasks need from you (TASK-933)', () => {
  beforeEach(() => {
    sendTaskReplyMock.mockReset();
  });

  it('lists grants, then tasks that need you, then the other approvals', () => {
    const { container } = renderToday({
      grants: [hostGrant],
      tasks: [needsYouTask()],
      decisions: [decision({ id: 'd2' })],
    });
    const text = container.textContent ?? '';
    const grant = text.indexOf('Allow access to example.org?');
    const task = text.indexOf(TASK_NAME);
    const loose = text.indexOf('Send the reply to Dana?');
    expect(grant).toBeGreaterThanOrEqual(0);
    expect(grant).toBeLessThan(task);
    expect(task).toBeLessThan(loose);
  });

  it('puts an approval held during a task’s check-in under that task, and keeps one without a task in the plain list', () => {
    renderToday({
      tasks: [needsYouTask()],
      decisions: [
        heldDuring('t1', TASK_NAME, { id: 'd1', summary: 'Close ticket #4410?' }),
        decision({ id: 'd2' }),
      ],
    });
    const block = taskBlock();
    expect(within(block).getByText('Close ticket #4410?')).toBeInTheDocument();
    expect(within(block).queryByText('Send the reply to Dana?')).toBeNull();
    expect(screen.getByText('Send the reply to Dana?')).toBeInTheDocument();
  });

  it('counts each task that needs you and each approval once', () => {
    const { container } = renderToday({
      tasks: [needsYouTask()],
      decisions: [
        heldDuring('t1', TASK_NAME, { id: 'd1', summary: 'Close ticket #4410?' }),
        decision({ id: 'd2' }),
      ],
    });
    expect(screen.getByText('Three things are waiting on you.')).toBeInTheDocument();
    expect(container.textContent).toMatch(/3 waiting on you/);
  });

  it('a task there only for its approvals adds nothing to the count', () => {
    renderToday({
      tasks: [onTrackTask()],
      decisions: [heldDuring('t2', 'Weekly invoice run', { id: 'd1' })],
    });
    expect(screen.getByText('One thing is waiting on you.')).toBeInTheDocument();
    expect(
      within(taskBlock(/Weekly invoice run/)).getByText('1 approval waiting'),
    ).toBeInTheDocument();
  });

  it('never says nothing is waiting when the tasks read failed, and offers Try again', () => {
    const onRetryTasks = vi.fn();
    renderToday({ tasksError: 'failed', onRetryTasks });
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
    expect(screen.getByText(COULD_NOT_CHECK)).toBeInTheDocument();
    const box = alertWith(TASKS_FAILED);
    expect(box.className).toContain('destructive');
    fireEvent.click(within(box).getByRole('button', { name: 'Try again' }));
    expect(onRetryTasks).toHaveBeenCalledTimes(1);
  });

  it('Try again waits while a tasks read is running (TASK-933 review)', () => {
    const onRetryTasks = vi.fn();
    const { rerender } = renderToday({ tasksError: 'failed', tasksRefreshing: true, onRetryTasks });
    const button = () =>
      within(alertWith(TASKS_FAILED)).getByRole('button', { name: 'Try again' });
    expect(button()).toBeDisabled();
    fireEvent.click(button());
    expect(onRetryTasks).not.toHaveBeenCalled();

    rerender(
      <TodayView
        decisions={[]}
        grants={[]}
        onGrantResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
        agents={[agent()]}
        filter="needs"
        expandedId={null}
        onExpand={vi.fn()}
        onOpenAgent={vi.fn()}
        onNavigate={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
        onSeeActivity={vi.fn()}
        tasks={[]}
        tasksError="failed"
        tasksRefreshing={false}
        unavailableTaskAgents={[]}
        onRetryTasks={onRetryTasks}
        onReplied={vi.fn()}
      />,
    );
    expect(button()).toBeEnabled();
  });

  it('an ended session offers sign-in, not Try again', () => {
    renderToday({ tasksError: 'expired', onRetryTasks: vi.fn() });
    const box = alertWith(DECISION_SESSION_EXPIRED);
    expect(box.className).not.toContain('destructive');
    expect(within(box).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
  });

  it('names the agents it couldn’t check, and doesn’t claim an empty day', () => {
    const onRetryTasks = vi.fn();
    renderToday({
      unavailableTaskAgents: [
        { agentId: 'a-juniper', agentName: 'Juniper' },
        { agentId: 'a-quill', agentName: 'Quill' },
      ],
      onRetryTasks,
    });
    const box = alertWith('We couldn’t check tasks from Juniper and Quill, so some may be missing.');
    expect(box.className).toContain('destructive');
    expect(screen.queryByText(TASKS_FAILED)).toBeNull();
    expect(screen.getByText(COULD_NOT_CHECK)).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'Try again' }));
    expect(onRetryTasks).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the tasks it has on screen', () => {
    renderToday({ tasksError: 'failed', tasks: [needsYouTask()] });
    expect(taskBlock()).toBeInTheDocument();
    expect(alertWith(TASKS_FAILED)).toBeInTheDocument();
    expect(screen.getByText('One thing is waiting on you.')).toBeInTheDocument();
  });

  it('a task still shows when the queue can’t be read', () => {
    renderToday({
      error: { kind: 'failed', detail: 'workspace /decisions → 503' },
      tasks: [needsYouTask()],
    });
    expect(taskBlock()).toBeInTheDocument();
    expect(screen.getByText(COULD_NOT_CHECK)).toBeInTheDocument();
  });

  it('tasks show under Needs you only', () => {
    const { rerender } = renderToday({ filter: 'needs', tasks: [needsYouTask()] });
    expect(taskBlock()).toBeInTheDocument();
    rerender(
      <TodayView
        decisions={[]}
        grants={[]}
        onGrantResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
        agents={[agent()]}
        filter="working"
        expandedId={null}
        onExpand={vi.fn()}
        onOpenAgent={vi.fn()}
        onNavigate={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
        onSeeActivity={vi.fn()}
        tasks={[needsYouTask()]}
        tasksError={null}
        tasksRefreshing={false}
        unavailableTaskAgents={[]}
        onRetryTasks={vi.fn()}
        onReplied={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: /Zero open support tickets/ })).toBeNull();
  });

  it('the empty-queue sentence waits for tasks too', () => {
    renderToday({ tasks: [needsYouTask()] });
    expect(taskBlock()).toBeInTheDocument();
    expect(screen.queryByText(/wait for you here/)).toBeNull();
  });

  it('a reply sent from a task’s block calls onReplied', async () => {
    sendTaskReplyMock.mockResolvedValue({ checkIn: 'started' });
    const onReplied = vi.fn();
    renderToday({ tasks: [needsYouTask()], onReplied });
    const block = taskBlock();
    fireEvent.click(within(block).getByRole('button', { name: 'Reply' }));
    fireEvent.change(
      within(block).getByRole('textbox', { name: 'Reply to Quill about this task' }),
      { target: { value: 'Yes, draft it' } },
    );
    fireEvent.click(within(block).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onReplied).toHaveBeenCalledTimes(1));
    expect(sendTaskReplyMock).toHaveBeenCalledWith('a-quill', 't1', {
      text: 'Yes, draft it',
      requestId: expect.any(String),
    });
  });
});
