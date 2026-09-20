/**
 * Presence routes a grant into the thread (TASK-351) — from the shell's side.
 *
 * `workspace-grant-presence.test.ts` pins the rule; this pins that the shipped
 * shell actually applies it, that the two render sites hold ONE grant between
 * them, and that presence is re-read continuously rather than sampled once when
 * the grant arrived.
 *
 * Everything mounts at a real `window.location` and reads a stubbed
 * `document.visibilityState`, because those two values ARE the rule. Both are
 * reset per test — jsdom keeps one location and one document per file, so
 * without the reset a test that hides the tab hides it for the next one too.
 *
 * The grant is seeded through the mount read-back (`GET /api/workspace/grants`,
 * TASK-373) rather than poked into the store, so what is under test is the
 * whole shipped path: the wire's `agentId` → the store → the presence rule →
 * whichever site draws it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import {
  getWorkspaceGrantSnapshot,
  workspaceGrantActions,
} from '@/lib/workspace-grant-store';
import type { PermissionRequest } from '@/server/types';
import { AgentConversation } from '../AgentConversation';
import { WorkspaceShell } from '../WorkspaceShell';
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
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      // TASK-444: turning a skill or connector grant down now records the
      // refusal, so `GrantRow` reaches for this. Left off, the row catches the
      // `TypeError` and STAYS — which is the honest failure, and would make
      // the refusal case below fail for a reason that has nothing to do with
      // presence routing.
      declineGrant: vi.fn(async () => ({ declined: true })),
      sendMessage: vi.fn(),
      streamReply: vi.fn(async () => {}),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const grantsMock = vi.mocked(workspaceApi.grants);
const sendMock = vi.mocked(workspaceApi.sendMessage);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

const agentRow = (id: string, name: string) => ({
  id,
  name,
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
});

const QUILL = agentRow('a-quill', 'Quill');
const SCOUT = agentRow('a-scout', 'Scout');

/**
 * A skill grant whose key is ALREADY SAVED. Deliberate: with nothing to type,
 * Connect is live on first render and answering it is exactly one POST, which
 * is what the "one POST either way" assertions below can count.
 */
const linearSkill = (): PermissionRequest => ({
  kind: 'skill',
  skillId: 'linear',
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key', account: 'linear', haveExisting: true }],
});

/**
 * A SECOND subject, raised by the OTHER agent — the queue-only half of a sum.
 * A different skill id rather than a `host`, because `raise` deliberately drops
 * a host wall while a connector grant is open and that rule is not what these
 * tests are about.
 */
const notionSkill = (): PermissionRequest => ({
  kind: 'skill',
  skillId: 'notion',
  description: 'Read and write Notion pages',
  hosts: ['api.notion.com'],
  slots: [{ slot: 'api_key', kind: 'api-key', account: 'notion', haveExisting: true }],
});

/** `document.visibilityState`, stubbed for the file and reset per test. */
let visibility: 'visible' | 'hidden' = 'visible';
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility,
});

/** Hide or show the tab the way a browser does: change, then announce. */
function setVisibility(next: 'visible' | 'hidden') {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Mount at `path`, as a browser landing there would. */
function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

/** The thread's out-of-band grant region. Absent when presence says queue. */
const threadRegion = () => screen.queryByTestId('thread-grants');

const grantRows = () => screen.queryAllByTestId('grant-skill:linear');

/**
 * The sidebar's "waiting on you" badge — the number, or `null` when the badge
 * is absent because the count is zero.
 */
const pendingBadge = () =>
  within(screen.getByRole('button', { name: /today/i })).queryByText(/^\d+$/);

beforeEach(() => {
  visibility = 'visible';
  window.history.replaceState(null, '', '/');
  workspaceGrantActions.resetForTest();
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [QUILL, SCOUT] });
  agentMock.mockReset();
  /*
    THE THREAD IS NOT EMPTY, and since TASK-374 it cannot be. Answering a grant
    now re-issues the turn the agent stopped on, which means reading this
    conversation back and re-sending its last user turn; with no user turn in it
    there is nothing to re-issue, the row stays with the "we could not start it
    again" sentence on it, and the three ANSWERING cases below — which assert the
    row leaves both sites — would fail for a reason that has nothing to do with
    presence. The resume path itself is pinned in `WorkspaceGrantResume.test.tsx`.
  */
  agentMock.mockImplementation(async (id: string) => ({
    agent: id === 'a-scout' ? SCOUT : QUILL,
    conversationId: 'cnv-1',
    thread: [{ kind: 'user' as const, id: 't1', text: 'file my open issues' }],
    decisions: { status: 'ok' as const },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null }, learned: { status: 'unavailable', docs: [] } },
  }));
  sendMock.mockReset();
  sendMock.mockResolvedValue({ conversationId: 'cnv-1', reqId: 'req-resume' });
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  grantsMock.mockReset();
  grantsMock.mockResolvedValue({
    grants: [
      { conversationId: 'cnv-1', agentId: 'a-quill', request: linearSkill() },
    ],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the thread takes the grant when the human is there', () => {
  it("draws it above the composer on that agent's chat tab", async () => {
    renderAt('/workspace/agents/a-quill');

    expect(await screen.findByTestId('thread-grants')).toBeInTheDocument();
    expect(screen.getByText('Connect Linear')).toBeInTheDocument();
    // One grant, drawn once on the site that is mounted. Today is not on
    // screen — the shell renders one view at a time — and the store still
    // holds the single row both sites read from.
    expect(grantRows()).toHaveLength(1);
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);
  });

  it('and Today still has the same grant, not a second one', async () => {
    // The queue never lets go: walking to Today finds the row waiting there,
    // still one row, because routing decides where we DRAW a grant and never
    // which grants exist.
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    fireEvent.click(screen.getByRole('button', { name: /today/i }));

    await waitFor(() => expect(threadRegion()).toBeNull());
    expect(grantRows()).toHaveLength(1);
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);
  });
});

describe('the badge counts a grant the thread is holding', () => {
  /*
    THE COUNT IS EVERY OPEN GRANT, wherever it happens to be drawn. A grant in
    front of you is still a grant waiting on you, and Today — one click away —
    is still listing it. Ticking the badge down the instant the question
    appeared would put two "waiting on you" numbers on one screen disagreeing
    with each other, which is the thing grants were added to this sum to stop.

    THIS BLOCK EXISTS BECAUSE EVERY OTHER COUNT ASSERTION IN THE SUITE RUNS ON
    TODAY, where presence never routes anything away and `grants.length` and
    `grants.length - grantsInThread.length` are the same number. This is the
    only route where the difference is visible, so without these three cases a
    refactor to the subtraction drops the badge the instant the question
    appears AND passes the entire suite green. (Confirmed, not assumed: that
    refactor reddens exactly these three and leaves `WorkspaceShell.test.tsx`
    and `TodayView.test.tsx` — every other count assertion we have — passing.)
  */

  it('still shows the badge while the grant is in the thread', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    expect(pendingBadge()).toHaveTextContent('1');
  });

  it('counts the queue-only grant and the thread-routed one alike', async () => {
    grantsMock.mockResolvedValue({
      grants: [
        { conversationId: 'cnv-1', agentId: 'a-quill', request: linearSkill() },
        { conversationId: 'cnv-2', agentId: 'a-scout', request: notionSkill() },
      ],
    });

    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    // Quill's is in front of us and Scout's is not; both are waiting on us.
    // The `2` is what makes this case sharper than the one above: a count that
    // subtracted the routed grant would say `1` here and still badge something,
    // so "the badge is present" alone would not have caught it.
    expect(grantRows()).toHaveLength(1);
    expect(screen.queryByTestId('grant-skill:notion')).toBeNull();
    expect(pendingBadge()).toHaveTextContent('2');
  });

  it('and reaches zero only when the grant is actually answered', async () => {
    /*
      The positive control. Without it the two assertions above would pass
      against a badge that had simply been wired to a constant — and it pins
      the shape of the intended tick-down: the number falls when the question
      is ANSWERED, not when it is merely displayed somewhere else.
    */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');
    expect(pendingBadge()).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(pendingBadge()).toBeNull());
  });
});

describe('everything else is the queue alone', () => {
  it("does not draw it in another agent's thread", async () => {
    renderAt('/workspace/agents/a-scout');

    // Wait for the thread to be genuinely on screen before concluding the
    // grant is not in it — otherwise this passes on an unmounted view.
    expect(
      await screen.findByPlaceholderText('Message Scout'),
    ).toBeInTheDocument();
    expect(threadRegion()).toBeNull();
    expect(grantRows()).toHaveLength(0);
    // Still waiting on the person, over on Today.
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);
  });

  it('does not draw it on a non-chat tab of the right agent', async () => {
    renderAt('/workspace/agents/a-quill/files');

    expect(await screen.findByRole('tab', { name: /files/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(threadRegion()).toBeNull();
  });

  it('draws it in the queue on Today, and in no thread', async () => {
    renderAt('/workspace');

    expect(await screen.findByTestId('grant-skill:linear')).toBeInTheDocument();
    expect(threadRegion()).toBeNull();
  });

  it('draws no thread card on Activity', async () => {
    renderAt('/workspace/activity');

    expect(
      await screen.findByRole('heading', { name: 'Activity' }),
    ).toBeInTheDocument();
    expect(threadRegion()).toBeNull();
  });

  it("does not draw it in a hidden tab, however right the route is", async () => {
    visibility = 'hidden';
    renderAt('/workspace/agents/a-quill');

    expect(
      await screen.findByPlaceholderText('Message Quill'),
    ).toBeInTheDocument();
    expect(threadRegion()).toBeNull();
  });
});

describe('presence is continuous, not sampled when the grant arrived', () => {
  it('takes the card out of the thread when the tab is hidden, and puts it back', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    setVisibility('hidden');
    expect(threadRegion()).toBeNull();
    // Not lost — just not here. The queue is still holding it.
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);

    setVisibility('visible');
    expect(threadRegion()).toBeInTheDocument();
  });

  it('takes it out when the route leaves the thread, and puts it back on return', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    await waitFor(() => expect(threadRegion()).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /quill/i }));
    expect(await screen.findByTestId('thread-grants')).toBeInTheDocument();
  });
});

describe('the render site itself', () => {
  /*
    The one block here that mounts the component rather than the shell. The
    shell cannot reach this state without a past-conversation fixture and two
    clicks, and what is being pinned is a property of the render site, not of
    the routing: a grant is OUT OF BAND. It is not a transcript row, so the
    transcript being read-only says nothing about it.
  */
  const renderConversation = (over: Record<string, unknown> = {}) =>
    render(
      <AgentConversation
        agent={QUILL}
        thread={[]}
        conversationId="c1"
        decisions={[]}
        readOnly={false}
        onSend={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
        approvalRead="ok"
        onRetryApprovals={vi.fn()}
        grants={[
          {
            key: 'skill:linear',
            request: linearSkill(),
            agentId: 'a-quill',
            conversationId: 'cnv-1',
          },
        ]}
        onGrantResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
        {...over}
      />,
    );

  it('draws nothing at all when no grant is routed here', () => {
    renderConversation({ grants: [] });

    // Positive control for every `toBeNull()` above: the region is absent, not
    // present-and-empty, so its absence there means something.
    expect(threadRegion()).toBeNull();
  });

  it('still draws the grant while a PAST conversation is open', () => {
    // The composer is hidden on a read-only excerpt. The grant is not part of
    // what was said — it is a live question holding this agent up — so hiding
    // it because somebody scrolled into history would orphan it exactly the
    // way presence routing exists to prevent.
    renderConversation({ readOnly: true });

    expect(threadRegion()).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Message Quill')).toBeNull();
  });
});

describe('one grant, two render sites, never two live copies', () => {
  /** The one POST a skill grant makes when its key is already saved. */
  function okPost() {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }

  const decisionPosts = (spy: ReturnType<typeof okPost>) =>
    spy.mock.calls.filter((c) =>
      String(c[0]).includes('/api/chat/permission-decision'),
    );

  it('answering in the thread clears it from the queue too, with one POST', async () => {
    const fetchSpy = okPost();
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    // The store is the single source of truth, so the row leaving it is the
    // row leaving BOTH sites. A thread that kept its own copy would still
    // have one here, and Today would still draw one below.
    await waitFor(() =>
      expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0),
    );
    expect(decisionPosts(fetchSpy)).toHaveLength(1);
    await waitFor(() => expect(threadRegion()).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('grant-skill:linear')).toBeNull(),
    );
    // Exactly one POST for the whole journey — the second site answering
    // nothing is the point.
    expect(decisionPosts(fetchSpy)).toHaveLength(1);
  });

  it('answering in the queue clears it from the thread too, with one POST', async () => {
    const fetchSpy = okPost();
    // POSITIVE CONTROL FIRST. Visit the thread and watch the card arrive, so
    // that finding it gone at the end means "the answer reached here" and not
    // "the thread never drew grants at all" — which is what this assertion
    // would silently mean if the routing were removed.
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    await screen.findByTestId('grant-skill:linear');
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() =>
      expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0),
    );

    fireEvent.click(screen.getByRole('button', { name: /quill/i }));
    expect(
      await screen.findByPlaceholderText('Message Quill'),
    ).toBeInTheDocument();
    expect(threadRegion()).toBeNull();
    expect(decisionPosts(fetchSpy)).toHaveLength(1);
  });

  it('turning it down in the thread turns it down in the queue, with no decision POST', async () => {
    // A refusal is RECORDED as a refusal (TASK-444) and is still not a
    // decision: nothing is granted, so `/api/chat/permission-decision` must
    // stay untouched. What it does do is reach both sites, which is the claim
    // this file is here for.
    const fetchSpy = okPost();
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    fireEvent.click(screen.getByRole('button', { name: /not now/i }));

    await waitFor(() => expect(threadRegion()).toBeNull());
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0);
    expect(decisionPosts(fetchSpy)).toHaveLength(0);
    expect(vi.mocked(workspaceApi.declineGrant)).toHaveBeenCalledWith(
      'a-quill',
      'skill',
      'linear',
    );
  });

  it('a grant the read-back and the stream both deliver stays one row', async () => {
    // The two producers meet at `raise`, which replaces on the SUBJECT key.
    // If identity were the (subject, agent) pair instead, a re-raise carrying
    // a different agent would add a row — and the thread and the queue would
    // then be showing two live copies of one question.
    renderAt('/workspace/agents/a-quill');
    await screen.findByTestId('thread-grants');

    act(() => {
      workspaceGrantActions.raise(linearSkill(), {
        conversationId: 'cnv-1',
        agentId: 'a-scout',
      });
    });

    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);
    // And the newer origin wins, so it is now Scout's grant — which means
    // Quill's open thread stops drawing it, without anything being duplicated.
    expect(threadRegion()).toBeNull();
    expect(getWorkspaceGrantSnapshot().grants[0]?.agentId).toBe('a-scout');
  });
});
