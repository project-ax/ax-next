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
  type AgentDetail,
  type WorkspaceAgent,
} from '@/lib/workspace-api';
import { AgentView } from '../AgentView';
import { DECISION_THREAD_READ_FAILED } from '../decision-copy';
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
    // The code is present, but on its own line — never inside the sentence a
    // non-technical reader has to parse.
    const prose = screen.getByText(/We could not load this agent/);
    expect(prose.textContent).not.toMatch(/ag_x/);
    expect(screen.getByText('workspace /agents/ag_x → 404')).toBeTruthy();

    fireEvent.click(retry);
    expect(await screen.findByText('what is on today')).toBeTruthy();
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
    // One statement about one event — the raw code lives below the prose, and
    // "send it again" is a button, not an instruction repeated twice.
    expect(line.textContent).not.toMatch(/500/);
    expect(line.textContent).not.toMatch(/send it again/i);
    expect(screen.getByText('the reply stream would not open (500)')).toBeTruthy();

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
    renderView({ decisions: [], decisionsError: 'decisions → 503' });

    expect(await screen.findByText(DECISION_THREAD_READ_FAILED)).toBeTruthy();
  });
});
