/**
 * The agent pane, held to the same rule as the rest of the surface: nothing
 * renders as content unless something real produced it, and every dead end
 * offers a way out.
 *
 * Three regressions are pinned here:
 *
 *   1. A past conversation used to render a lone divider reading "Earlier turns
 *      were summarised into memory · 0 messages folded" over an empty
 *      transcript. Three claims, none of them true: nothing was summarised, the
 *      zero was a fixture, and the excerpt was never fetched.
 *   2. The agent-load error printed a raw code inside the sentence and told the
 *      reader to try again with no way to do it.
 *   3. The dropped-stream error said "send it again" twice and meant RETYPE —
 *      the composer had already cleared the draft.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  workspaceApi,
  WorkspaceApiError,
  type AgentDetail,
  type WorkspaceAgent,
} from '@/lib/workspace-api';
import { AgentView } from '../AgentView';
import {
  DECISION_SESSION_EXPIRED,
  DECISION_THREAD_READ_FAILED,
} from '../decision-copy';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      // The rail reads its own route (AW-14). Without it in the mock, mounting
      // the chat tab throws before this file's subject renders at all.
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const agentMock = vi.mocked(workspaceApi.agent);
const sendMock = vi.mocked(workspaceApi.sendMessage);
const streamMock = vi.mocked(workspaceApi.streamReply);

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c-now',
    thread: [{ kind: 'user', id: 't1', text: 'what is on today' }],
    decisions: { status: 'ok' },
    past: [],
    memory: [],
    ...over,
  };
}

/** Current detail carries one past row; `?conversationId=` returns its turns. */
function withPast() {
  agentMock.mockImplementation(async (_id: string, conversationId?: string) =>
    conversationId === 'c-old'
      ? detail({
          conversationId: 'c-old',
          thread: [{ kind: 'user', id: 'o1', text: 'the March question' }],
        })
      : detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] }),
  );
}

function renderView(over: Partial<ComponentProps<typeof AgentView>> = {}) {
  return render(
    <AgentView
      agentId="a-quill"
      tab="chat"
      onTab={vi.fn()}
      decisions={[]}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      decisionsError={null}
      version={0}
      onChanged={vi.fn()}
      {...over}
    />,
  );
}

beforeEach(() => {
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
});

describe('past conversations', () => {
  it('fetches the real excerpt and invents no fold marker', async () => {
    withPast();

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'March' }));

    expect(await screen.findByText('the March question')).toBeTruthy();
    await waitFor(() =>
      expect(agentMock).toHaveBeenCalledWith('a-quill', 'c-old'),
    );
    // The three claims that used to sit above an empty transcript.
    expect(screen.queryByText(/summarised into memory/)).toBeNull();
    expect(screen.queryByText(/messages folded/)).toBeNull();
    expect(screen.queryByText(/0 messages/)).toBeNull();
  });

  it('keeps a past conversation read-only', async () => {
    withPast();

    renderView();
    // The current conversation has a composer…
    expect(await screen.findByPlaceholderText('Message Quill')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'March' }));
    await screen.findByText('the March question');

    // …and the past one does not.
    expect(screen.queryByPlaceholderText('Message Quill')).toBeNull();
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });

  it('says so when the excerpt will not open, instead of showing a blank one', async () => {
    agentMock.mockImplementation(async (_id: string, conversationId?: string) => {
      if (conversationId === 'c-old') throw new Error('workspace /agents → 404');
      return detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] });
    });

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'March' }));

    expect(
      await screen.findByText(/could not open that conversation/i),
    ).toBeTruthy();
  });
});

describe('the agent will not load', () => {
  it('offers a Try again that actually re-runs the load', async () => {
    agentMock.mockRejectedValueOnce(new Error('workspace /agents/ag_x → 404'));
    agentMock.mockResolvedValue(detail());

    renderView();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    /*
      TASK-288 — the raw detail used to be asserted PRESENT here, on its own
      mono line: `workspace /agents/ag_x → 404`. Keeping it off the sentence
      was the right instinct; keeping it on the screen at all was not. A
      request path and a status code are an internal identifier, and this is
      the screen where someone learns their session ended by reading `401`.
      It goes to the console now, so the assertion is inverted.
    */
    const prose = screen.getByText(/We could not load this agent/);
    expect(prose.textContent).not.toMatch(/ag_x/);
    expect(document.body.textContent).not.toMatch(/ag_x|404|→/);

    fireEvent.click(retry);
    expect(await screen.findByText('what is on today')).toBeTruthy();
  });

  /*
    THE CARD'S HEADLINE DEFECT. This alert's own copy said the agent "may have
    been removed" — so it knew a 404 was reachable — and offered "Try again"
    anyway, which a 404 makes useless. `lib/read-register.ts` rules `gone` gets
    no retry affordance; this is the surface that ruling was written for.

    A branch with NO control would be the same trap in a different hat, because
    this alert replaces the whole pane including the header's Back button. So
    `gone` gets a way off the dead pane instead of a way to re-run a request
    that will fail identically.
  */
  it('does not offer to retry an agent that is not there', async () => {
    agentMock.mockRejectedValue(new WorkspaceApiError('/agents/ag_x', 404));

    renderView();

    expect(await screen.findByText(/may have been removed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // Not stranded: an escape hatch is not a retry, so the ruling permits it.
    expect(screen.getByRole('button', { name: 'Back to agents' })).toBeTruthy();
  });

  /*
    The other half of the same defect: the deletion story was told
    UNCONDITIONALLY, so a 500 sent the reader hunting for a removal that never
    happened. Retrying is exactly right for a blip, and the reassurance about
    work and memory is only true here — an agent that really was removed did not
    keep its memory.
  */
  it('does not blame a deletion for a server blip', async () => {
    agentMock.mockRejectedValue(new WorkspaceApiError('/agents/ag_x', 500));

    renderView();

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/may have been removed/)).toBeNull();
    expect(screen.queryByText(/belong to someone else/)).toBeNull();
    expect(screen.getByText(/work and its memory are safe/)).toBeTruthy();
  });

  /*
    A 401 is not a deletion and not a blip, and it is the case the pre-TASK-296
    copy got most wrong: it told a signed-out reader their agent might have been
    removed. No local "Sign in" button, deliberately — the 401 latch in
    `lib/http.ts` flips the app to `<LoginPage />`, which holds the real one.
  */
  it('says the session ended rather than guessing at a deletion', async () => {
    agentMock.mockRejectedValue(new WorkspaceApiError('/agents/ag_x', 401));

    renderView();

    expect(await screen.findByText(/session has ended/i)).toBeTruthy();
    expect(screen.queryByText(/may have been removed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

/*
  The read-only excerpt's alert.

  It was the only alert on this surface with NO WAY OUT AT ALL — no retry, no
  sign-in, not even a dismiss — over a pane deliberately blanked while the error
  is set. And its one sentence claimed a deletion on every failure mode.

  The 401 test here is the one the card called for by name: the pre-existing
  excerpt test threw a plain `Error`, which classifies as `failed` no matter how
  the status branch is written, so it could not have caught a broken one.
*/
describe('AgentView — an excerpt that will not open', () => {
  function withFailingExcerpt(err: unknown) {
    agentMock.mockImplementation(async (_id: string, conversationId?: string) => {
      if (conversationId === 'c-old') throw err;
      return detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] });
    });
  }

  async function openMarch() {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'March' }));
  }

  /*
    A REAL `WorkspaceApiError`, which is the whole point of this test. Its
    `detail` is `workspace /agents/ag_quill?conversationId=cnv_… → 401`, and
    that string used to be flattened onto the screen — a request path, a status,
    AND a conversation id, the same class of identifier TASK-260 spent a card
    removing from the surfaces people read. It belongs in the console.
  */
  it('never prints the request behind the failure', async () => {
    withFailingExcerpt(
      new WorkspaceApiError('/agents/ag_quill?conversationId=cnv_march', 401),
    );

    await openMarch();

    expect(await screen.findByText(/session has ended/i)).toBeTruthy();
    expect(screen.queryByText(/workspace \//)).toBeNull();
    expect(document.body.textContent).not.toMatch(/cnv_march|ag_quill|401|→/);
  });

  /* The sentence that was always right — now firing only where it is true. */
  it('keeps the deletion story for the one status that supports it', async () => {
    withFailingExcerpt(new WorkspaceApiError('/agents/ag_x', 404));

    await openMarch();

    expect(await screen.findByText(/deleted since this list was drawn/)).toBeTruthy();
    // Nothing brings a deleted conversation back.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  /*
    The alert's missing action. `retryApprovals` was already bumping
    `pastReload` — the exact re-read this needs — but it was wired only to
    `AgentConversation`'s approval notice, so a reader whose excerpt failed on a
    blip was stranded until they happened to click a different rail row.
  */
  it('offers a Try again that actually re-opens the excerpt', async () => {
    let failing = true;
    agentMock.mockImplementation(async (_id: string, conversationId?: string) => {
      if (conversationId === 'c-old') {
        if (failing) throw new WorkspaceApiError('/agents/ag_x', 500);
        return detail({
          conversationId: 'c-old',
          thread: [{ kind: 'user', id: 'o1', text: 'the March question' }],
        });
      }
      return detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] });
    });

    await openMarch();

    expect(await screen.findByText(/could not open that conversation/)).toBeTruthy();
    // No fabricated cause on a blip.
    expect(screen.queryByText(/deleted since this list was drawn/)).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('the March question')).toBeTruthy();
    expect(screen.queryByText(/could not open that conversation/)).toBeNull();
  });

  /*
    THE NULL-GATE PIN the card asked for.

    `pastError` moved from `string` to `ReadOutcome`, and every gate on it is an
    explicit `!== null` / `=== null` check rather than a truthiness test — so the
    swap is behaviour-preserving. That is worth one test rather than a reading,
    because the failure mode is silent: `'expired'` and `'gone'` are both truthy,
    but so was every string, and a future `if (pastError)` would keep working
    right up until somebody introduced a falsy member. What must hold is that a
    failed excerpt renders NEITHER a transcript nor the "Opening…" placeholder —
    an empty thread is a claim about the content, and the placeholder is a claim
    that a fetch is still running.
  */
  it('blanks the pane rather than claiming the conversation was empty or is still opening', async () => {
    withFailingExcerpt(new WorkspaceApiError('/agents/ag_x', 500));

    await openMarch();

    expect(await screen.findByText(/could not open that conversation/)).toBeTruthy();
    expect(screen.queryByText('Opening…')).toBeNull();
    // The CURRENT conversation's turn must not leak into the excerpt pane.
    expect(screen.queryByText('what is on today')).toBeNull();
  });
});

/*
  A send that fails because the conversation it aimed at is gone.

  Two controls cannot work in that state and both used to be offered: "Resend",
  which re-fires into the same 404, and — less obviously — the composer itself,
  because `conversationRef` was left pointing at the vanished row, so every
  following message failed the same way for the rest of the session.
*/
describe('a send into a conversation that is gone', () => {
  it('withdraws Resend and lets the next message start somewhere new', async () => {
    agentMock.mockResolvedValue(detail());
    sendMock.mockRejectedValueOnce(new WorkspaceApiError('/chat/messages', 404));

    renderView();
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'summarise the roof quote' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    // A Resend would re-target the same missing row.
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
    // Dismiss survives: the strip sits over a conversation still worth reading.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    // And no plumbing on screen.
    expect(document.body.textContent).not.toMatch(/404|→/);

    // The composer is not dead for the rest of the session: the next message
    // starts a fresh conversation instead of re-aiming at the missing one.
    sendMock.mockResolvedValue({ conversationId: 'c-new', reqId: 'r2' });
    streamMock.mockResolvedValue(undefined as never);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    const box2 = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box2, { target: { value: 'try again from scratch' } });
    fireEvent.keyDown(box2, { key: 'Enter' });

    await waitFor(() =>
      expect(sendMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: null }),
      ),
    );
  });
});

describe('a reply that did not finish', () => {
  it('says it once and resends the held text without retyping', async () => {
    agentMock.mockResolvedValue(detail());
    sendMock.mockResolvedValue({ conversationId: 'c-now', reqId: 'r1' });
    streamMock.mockImplementation(
      async (_reqId: string, h: { onError: (m: string) => void }) => {
        h.onError('the reply stream would not open (500)');
      },
    );

    renderView();
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'summarise the roof quote' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const line = await screen.findByText(/didn’t finish/);
    // One statement about one event, and "send it again" is a button rather
    // than an instruction repeated twice.
    expect(line.textContent).not.toMatch(/500/);
    expect(line.textContent).not.toMatch(/send it again/i);
    /*
      THE TRANSPORT'S SENTENCE STAYS, and a reviewer talked me out of removing
      it. Every producer of this string is authored copy, and one of them —
      an `ERROR_LABELS` label plus the optional TASK-160 `detail` line — is the
      only actionable specifics the reader gets ("a dev service failed to
      start", and which one). `server/types.ts` says outright that `detail` is
      bounded, sanitized, and meant to be rendered. Collapsing it into our
      generic sentence was a UX regression dressed as a cleanup.

      What this card DID take off the screen is the raw reason code that used to
      arrive glued to it (see the `dev-service-failed` test below) and the
      request path and status on the other two alerts. This fixture's `(500)` is
      the test's own invention, not something a producer emits, so it is
      asserted present only to prove the channel still carries authored text.
    */
    expect(
      screen.getByText('the reply stream would not open (500)'),
    ).toBeTruthy();

    sendMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'summarise the roof quote' }),
      ),
    );
  });
});

/*
  "What it did" is the shared `ActivityFeed` with `agentId` set, and nothing
  else (design §7 / plan task AW-12 step 4). If this tab ever needs a component
  change beyond passing that prop, the feed is not one component and THAT is
  the bug to fix — so what is pinned here is the two observable consequences of
  the prop being set, not the prop itself.
*/
describe('the "What it did" tab', () => {
  it('renders the shared feed scoped to this agent', async () => {
    agentMock.mockResolvedValue(detail());

    renderView({
      tab: 'did',
      activity: [
        {
          id: 'a-quill|daily.md|1',
          agentId: 'a-quill',
          at: new Date().toISOString(),
          text: 'Morning inbox sweep',
          kind: 'done',
          detail: null,
          tag: 'Scheduled',
          decisionId: null,
        },
      ],
    });

    expect(await screen.findByText('Morning inbox sweep')).toBeTruthy();
    // Scoped: no per-row "open this agent" button, because every row is this
    // agent. An unscoped feed renders one on every row.
    expect(screen.queryByRole('button', { name: 'Quill' })).toBeNull();
  });

  it('says the RECORD is empty, not that the agent did nothing', async () => {
    agentMock.mockResolvedValue(detail());

    renderView({ tab: 'did', activity: [] });

    // The scoped phrasing — "what Quill does", not "what your agents do".
    expect(
      await screen.findByText(/The record of what Quill does is empty so far/),
    ).toBeTruthy();
  });

  it('shows a read failure instead of an empty record', async () => {
    agentMock.mockResolvedValue(detail());

    renderView({ tab: 'did', activity: [], activityError: 'boom' });

    expect(await screen.findByText(/could not load the record/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing recorded yet/)).toBeNull();
  });
});

/*
  The approval notice.

  The panel shows approval cards by POINTER: the server decides which of this
  conversation's decisions are still open, and the shell's queue carries the
  rows those pointers name. Either read can fail, and when one does the thread
  simply comes up short — which on this surface is a sentence: "nothing is
  waiting on you." These tests exist because that sentence was being said by
  accident, from both sides.
*/
describe('AgentView — the approval read', () => {
  it('says we could not check, rather than showing a thread with no cards', async () => {
    agentMock.mockResolvedValue(detail({ decisions: { status: 'failed' } }));

    renderView();

    // The reader is told the panel does not know. Before this, an unreadable
    // approval set and a conversation with nothing waiting in it looked
    // identical on screen.
    expect(await screen.findByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();
    // And the panel stays up around it — losing the approval read costs the
    // cards, never the transcript.
    expect(screen.getByText('what is on today')).toBeTruthy();
  });

  it('offers a retry that actually re-reads', async () => {
    const onChanged = vi.fn();
    agentMock.mockResolvedValue(detail({ decisions: { status: 'failed' } }));

    renderView({ onChanged });

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    // `onChanged` is the one call that re-pulls BOTH reads behind the notice:
    // the shell's queue, and this panel's own detail. A notice whose button
    // swallowed the click would be worse than no button at all.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('stays quiet when this deployment has no decisions producer at all', async () => {
    agentMock.mockResolvedValue(detail({ decisions: { status: 'unavailable' } }));

    renderView();

    expect(await screen.findByText('what is on today')).toBeTruthy();
    // `unavailable` is not a failure. Nothing can raise a decision here, so a
    // thread with no approval cards is COMPLETE — and a notice would have the
    // panel cast doubt on a thread it can vouch for.
    expect(screen.queryByText(DECISION_THREAD_READ_FAILED)).toBeNull();
  });

  it('describes the EXCERPT on screen, not the conversation behind it', async () => {
    // The current conversation read fine; the past one we are looking at did
    // not. A notice taken off the current conversation would call this excerpt
    // trustworthy, and a reader deciding whether anything is waiting in it
    // would be reading an answer about a different thread.
    agentMock.mockImplementation(async (_id: string, conversationId?: string) =>
      conversationId === 'c-old'
        ? detail({
            conversationId: 'c-old',
            thread: [{ kind: 'user', id: 'o1', text: 'the March question' }],
            decisions: { status: 'failed' },
          })
        : detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] }),
    );

    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'March' }));

    expect(await screen.findByText('the March question')).toBeTruthy();
    expect(screen.getByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();
  });

  it('retries the EXCERPT too, not just the current conversation', async () => {
    let excerptFails = true;
    agentMock.mockImplementation(async (_id: string, conversationId?: string) =>
      conversationId === 'c-old'
        ? detail({
            conversationId: 'c-old',
            thread: [{ kind: 'user', id: 'o1', text: 'the March question' }],
            decisions: { status: excerptFails ? 'failed' : 'ok' },
          })
        : detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] }),
    );

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'March' }));
    expect(await screen.findByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();

    // The read recovers, and the reader presses the button we gave them.
    excerptFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    /*
      The excerpt has its OWN read, and the shell's `version` bump does not
      reach it — that effect keys on `[agentId, pastId, pastReload]` so a stray
      approval elsewhere cannot blank an open excerpt back to "Opening…". So a
      retry wired only to `onChanged` re-read everything EXCEPT the read the
      notice was reporting, and the notice could never clear: the only way out
      was "Back to current" and reopening.
    */
    await waitFor(() =>
      expect(screen.queryByText(DECISION_THREAD_READ_FAILED)).toBeNull(),
    );
  });

  it('offers a sign-in, not a retry, when the session ran out', async () => {
    agentMock.mockResolvedValue(detail({ decisions: { status: 'ok' } }));

    renderView({
      decisions: [],
      decisionsError: { kind: 'expired', detail: 'workspace /decisions \u2192 401' },
    });

    /*
      A 401 is not a blip. Every retry returns the same 401 until the reader
      signs in, so "Try again" here would be a button that cannot work — and
      "we could not read the approvals" would apologise for a failure that did
      not happen. The same line TASK-276 drew on Today and on the in-thread
      card; this surface has to draw it too or it becomes the one place that
      still points at the dead button.
    */
    expect(await screen.findByText(DECISION_SESSION_EXPIRED)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText(DECISION_THREAD_READ_FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('lets an expired session outrank a failed server read', async () => {
    agentMock.mockResolvedValue(detail({ decisions: { status: 'failed' } }));

    renderView({
      decisions: [],
      decisionsError: { kind: 'expired', detail: 'workspace /decisions \u2192 401' },
    });

    // Both are true at once and only one is worth telling them: signed out is
    // the fact that explains the other and the only one they can act on.
    expect(await screen.findByText(DECISION_SESSION_EXPIRED)).toBeTruthy();
    expect(screen.queryByText(DECISION_THREAD_READ_FAILED)).toBeNull();
  });

  it('says it when the QUEUE read failed, even though the server read was fine', async () => {
    agentMock.mockResolvedValue(
      detail({
        decisions: { status: 'ok' },
        thread: [
          { kind: 'user', id: 't1', text: 'what is on today' },
          { kind: 'approval', id: 'decision-d1', decisionId: 'd1' },
        ],
      }),
    );

    // The rows those pointers name never arrived, so the card renders nothing.
    // Without the notice this thread reads exactly like a settled one — the
    // client-side half of the same lie, and the half the shell used to cause
    // by passing the queue's rows down here without its error.
    renderView({
      decisions: [],
      decisionsError: { kind: 'failed', detail: 'workspace /decisions → 503' },
    });

    expect(await screen.findByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();
  });
});
