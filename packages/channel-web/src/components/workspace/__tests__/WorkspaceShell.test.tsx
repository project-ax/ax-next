/**
 * The workspace stands on the real host now, and the rule this whole task
 * exists to enforce is: everything with no real source yet renders its EMPTY
 * STATE, not a fixture. These tests pin both halves of that — what the shell
 * shows comes from the API, and what the API has nothing for says so.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { DECISION_THREAD_READ_FAILED } from '../decision-copy';
import { decisionFixture } from './decision-fixture';
import type { ActivityEvent } from '@/lib/workspace-types';

import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      // The rail reads its own route (TASK-235 / AW-14). Without it in the
      // mock, opening an agent throws before this file's subject renders.
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const agentMock = vi.mocked(workspaceApi.agent);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

function renderShell() {
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

beforeEach(() => {
  boardMock.mockReset();
  agentMock.mockReset();
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
});

describe('WorkspaceShell', () => {
  it('renders the roster from the API, not a fixture', async () => {
    // Names that appear nowhere in the component sources — if they render,
    // they came off the wire.
    boardMock.mockResolvedValue({
      agents: [
        {
          id: 'a-quill',
          name: 'Quill',
          state: 'resting',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
        {
          id: 'a-tern',
          name: 'Tern',
          state: 'working',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
      ],
    });

    renderShell();

    expect(await screen.findByText('Quill')).toBeTruthy();
    expect(screen.getByText('Tern')).toBeTruthy();
    // The prototype's cast is gone with the mock that invented it.
    expect(screen.queryByText('Scheduler')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();
  });

  it('shows the honest empty state when there are no decisions', async () => {
    boardMock.mockResolvedValue({ agents: [] });

    renderShell();

    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();
  });

  it('does not offer a demo strip or a global stop', async () => {
    // Both drove mock-only routes. A control wired to nothing is worse than no
    // control, because it reads as a promise.
    boardMock.mockResolvedValue({ agents: [] });

    renderShell();
    await screen.findByText('Nothing is waiting on you.');

    expect(screen.queryByText('Prototype')).toBeNull();
    expect(screen.queryByText(/Stop everything/)).toBeNull();
    expect(screen.queryByText('New agent')).toBeNull();
  });

  it('does not badge a tab with a zero', async () => {
    // "Needs you 0" is a number nobody needs. The queue read succeeded and came
    // back empty, so the honest thing to render is the headline saying so — not
    // a zero pinned to a tab.
    boardMock.mockResolvedValue({ agents: [] });

    renderShell();
    const tab = await screen.findByRole('radio', { name: /Needs you/ });

    expect(tab.textContent).toBe('Needs you');
    expect(tab.textContent).not.toMatch(/0/);
  });

  it('never claims the queue is empty when the queue read FAILED', async () => {
    /*
      The roster loaded; the queue did not. "Nothing is waiting on you." here
      would be the single most damaging sentence this product can print — it is
      indistinguishable from the true version and means the opposite (H7).
    */
    boardMock.mockResolvedValue({ agents: [] });
    decisionsMock.mockRejectedValue(new Error('workspace /decisions → 503'));

    renderShell();

    expect(
      await screen.findByText('We could not check what is waiting on you.'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
  });

  it('scopes the feed to ONE agent when that agent is open, and only then', async () => {
    /*
      "What it did" is the one feed with `agentId` set (design §7). The scoping
      happens HERE, in the fetch, not in the renderer — a tab that rendered the
      unfiltered collection under one agent's heading would be a 200 that
      quietly means something else, and it would look completely normal.

      Both halves matter. Asserting only the scoped call would pass against a
      hook that always scopes, which would break the global Activity page.
    */
    boardMock.mockResolvedValue({
      agents: [
        {
          id: 'a-quill',
          name: 'Quill',
          state: 'resting',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
      ],
    });
    agentMock.mockResolvedValue({
      agent: {
        id: 'a-quill',
        name: 'Quill',
        state: 'resting',
        now: null,
        counter: null,
        startedAt: null,
        stoppedReason: null,
      },
      conversationId: null,
      thread: [],
      decisions: { status: 'ok' },
      past: [],
      memory: [],
    });

    renderShell();

    // The whole workspace, before anything is open.
    await waitFor(() => expect(activityMock).toHaveBeenCalledWith({}));

    fireEvent.click(await screen.findByRole('button', { name: /Quill/ }));
    await waitFor(() =>
      expect(activityMock).toHaveBeenCalledWith({ agentId: 'a-quill' }),
    );
  });

  it('carries a failed queue read INTO the agent tab, not just onto Today', async () => {
    boardMock.mockResolvedValue({
      agents: [
        {
          id: 'a-quill',
          name: 'Quill',
          state: 'resting',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
      ],
    });
    activityMock.mockResolvedValue({ events: [], nextBefore: null });
    decisionsMock.mockRejectedValue(new Error('decisions → 503'));
    agentMock.mockResolvedValue({
      agent: {
        id: 'a-quill',
        name: 'Quill',
        state: 'resting',
        now: null,
        counter: null,
        startedAt: null,
        stoppedReason: null,
      },
      conversationId: 'c-now',
      // The server's own approval read was fine — it is the QUEUE, the one
      // that carries the rows this pointer names, that never came back.
      thread: [
        { kind: 'user', id: 't1', text: 'what is on today' },
        { kind: 'approval', id: 'decision-d1', decisionId: 'd1' },
      ],
      decisions: { status: 'ok' },
      past: [],
      memory: [],
    });

    renderShell();

    fireEvent.click(await screen.findByRole('button', { name: /Quill/ }));

    /*
      This assertion is about the SHELL, not the panel. Every other piece of
      the queue was already threaded into the agent tab — the rows, the three
      handlers, `busyIds`, `notices` — and the error was not, so a failed queue
      read arrived here as an empty array and the thread showed no approval
      card and no explanation. The panel can only tell the reader what it is
      handed.
    */
    expect(await screen.findByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();
  });

  it('clears that notice — and shows the card — when the retry gets the queue back', async () => {
    boardMock.mockResolvedValue({
      agents: [
        {
          id: 'a-quill',
          name: 'Quill',
          state: 'resting',
          now: null,
          counter: null,
          startedAt: null,
          stoppedReason: null,
        },
      ],
    });
    activityMock.mockResolvedValue({ events: [], nextBefore: null });
    // Down for the first read, back for every one after it.
    decisionsMock.mockRejectedValueOnce(new Error('decisions → 503'));
    decisionsMock.mockResolvedValue({
      decisions: [decisionFixture({ id: 'd1', agentId: 'a-quill', conversationId: 'c-now' })],
    });
    agentMock.mockResolvedValue({
      agent: {
        id: 'a-quill',
        name: 'Quill',
        state: 'resting',
        now: null,
        counter: null,
        startedAt: null,
        stoppedReason: null,
      },
      conversationId: 'c-now',
      thread: [
        { kind: 'user', id: 't1', text: 'what is on today' },
        { kind: 'approval', id: 'decision-d1', decisionId: 'd1' },
      ],
      decisions: { status: 'ok' },
      past: [],
      memory: [],
    });

    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: /Quill/ }));
    expect(await screen.findByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    /*
      The notice going away is only half of it, and on its own it would be the
      weaker half — a notice can disappear because the retry succeeded or
      because something stopped rendering it. What proves the retry did its job
      is the CARD the failed read was hiding: the pointer in the thread finally
      finds its row, so the question the agent stopped to ask is on screen and
      answerable.
    */
    expect(
      await screen.findByText('Move your 1:1 with Marcus to Thursday 9:30?'),
    ).toBeTruthy();
    expect(screen.queryByText(DECISION_THREAD_READ_FAILED)).toBeNull();
  });

  it('says what we know and what to try when the board will not load', async () => {
    boardMock.mockRejectedValue(new Error('workspace /state → 503'));

    renderShell();

    expect(
      await screen.findByText('We could not load your workspace.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

/*
  The ActivityFeed's own tests moved to `ActivityFeed.test.tsx` when the feed
  grew a real collection behind it (AW-10). They were never about the shell.
*/

/*
  Today's "N done today" is a claim about the whole local day, and the shell
  only ever holds page ONE of the activity feed (fifty rows; Today never calls
  `loadMore`). So the count is honest only while the fetched window reaches
  back past local midnight — which is exactly what these pin. TASK-252.
*/
describe('the "done today" count', () => {
  const midnight = (): number => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  };
  const iso = (ms: number): string => new Date(ms).toISOString();

  /** A `done` row — the only kind the count looks at. */
  function doneEvent(n: number): ActivityEvent {
    return {
      id: `e-${n}`,
      agentId: 'a-quill',
      // A minute past midnight: unambiguously today for any reader in this
      // process's timezone, which is the one the component reads too.
      at: iso(midnight() + 60_000),
      text: `Swept the inbox (${n})`,
      kind: 'done',
      detail: null,
      tag: null,
      decisionId: null,
    };
  }

  /** More than the server's fifty-row page — the case the count got wrong. */
  const busyDay = Array.from({ length: 51 }, (_, i) => doneEvent(i));

  /**
   * Renders Today and lands ONE activity page, deterministically: the fetch is
   * held open until the shell is up, so a negative assertion below cannot pass
   * merely because the response had not arrived yet.
   */
  async function landPage(page: {
    events: ActivityEvent[];
    nextBefore: string | null;
  }): Promise<void> {
    let release: (() => void) | undefined;
    activityMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(page);
        }),
    );
    boardMock.mockResolvedValue({ agents: [] });

    renderShell();
    await screen.findByText('Nothing is waiting on you.');
    await act(async () => {
      release?.();
    });
  }

  it('shows the count once the fetched window reaches back past midnight', async () => {
    // The cursor sits a second before midnight, so every one of today's rows
    // is already in hand — even though there is plainly more history behind
    // it. More pages existing is not a reason to withhold a day's count.
    await landPage({ events: busyDay, nextBefore: iso(midnight() - 1_000) });

    expect(await screen.findByText(/51 done today/)).toBeTruthy();
  });

  it('shows the count when the feed has nothing older left to give', async () => {
    // `nextBefore: null` — the record ends here, so the window covers today by
    // definition.
    await landPage({ events: busyDay, nextBefore: null });

    expect(await screen.findByText(/51 done today/)).toBeTruthy();
  });

  it('hides the count while the fetched window stops short of midnight', async () => {
    /*
      The cursor is still inside today: rows from earlier this morning have not
      been fetched, so 51 is a FLOOR, not the day's total. Rendering it would
      state a number we cannot back — the bug this card fixes. An absent line
      is the honest answer.
    */
    await landPage({ events: busyDay, nextBefore: iso(midnight() + 30_000) });

    expect(screen.queryByText(/done today/)).toBeNull();
  });

  it('hides the count when the cursor sits exactly on midnight', async () => {
    /*
      Exactly on the boundary is NOT past it. The cursor is exclusive on both
      sources, so a row sharing that millisecond can be cut from the page and
      never appear on the next one. Conservative on purpose.
    */
    await landPage({ events: busyDay, nextBefore: iso(midnight()) });

    expect(screen.queryByText(/done today/)).toBeNull();
  });
});
