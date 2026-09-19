/**
 * TASK-250 / T4 — the zero-turn thread, and the one place it must stay silent.
 *
 * `AgentConversation` rendered literally nothing for an empty thread: the only
 * workspace surface with no empty copy at all, and the one a day-one user
 * reaches by clicking their only agent in the rail.
 *
 * The gate is the interesting half. `AgentView` passes
 * `readOnly={past !== null}` and its `pastThread` renders `[]` while
 * `pastError` is set, so a past conversation whose
 * excerpt read FAILED arrives here as an empty thread. "Nothing here yet" over
 * that is a claim about the content assembled from a fact about the fetch, and
 * it is exactly the H7 dishonesty this surface is built to avoid. The
 * read-only test below is what would catch that lie if the gate were ever
 * loosened to a bare `thread.length === 0` — which is what the copy alone
 * would tempt someone into.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';
import type { PermissionRequest } from '@/server/types';

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/**
 * A grant routed into this thread. Shaped like
 * `WorkspaceGrantPresence.test.tsx`'s, which renders this same component with
 * an EMPTY thread and a grant — i.e. the collision below is not hypothetical,
 * it is already a fixture somebody wrote for another reason.
 */
const routedGrant: WorkspaceGrant = {
  key: 'skill:linear',
  request: {
    kind: 'skill',
    skillId: 'linear',
    description: 'File and read Linear issues',
    hosts: ['api.linear.app'],
    slots: [
      { slot: 'api_key', kind: 'api-key', account: 'linear', haveExisting: true },
    ],
  } satisfies PermissionRequest,
  agentId: 'a-quill',
  conversationId: 'cnv-1',
};

const EMPTY_TITLE = 'Nothing here yet';
const EMPTY_DESCRIPTION =
  'This is where you and Quill talk. Send something below — Quill picks it up from there.';

function renderConversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return render(
    <AgentConversation
      agent={quill}
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
      /*
        No grant is ever in play here: a zero-turn thread cannot be hiding one,
        because a grant is raised DURING a turn. These three are required props
        that the empty-state branch has nothing to say about, filled the same
        way the sibling `AgentConversation*` suites fill them.
      */
      grants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      {...over}
    />,
  );
}

describe('AgentConversation — the zero-turn thread', () => {
  it('names where the reader is, and who they are talking to, on a live empty thread', () => {
    renderConversation({ thread: [], readOnly: false });

    expect(screen.getByText(EMPTY_TITLE)).toBeTruthy();
    // The agent's own name, twice, from the prop — not a fixture, and not a
    // generic "your agent". This is the sentence a day-one user reads.
    expect(screen.getByText(EMPTY_DESCRIPTION)).toBeTruthy();
  });

  it('promises nothing about what the agent can do', () => {
    /*
      The hard copy constraint, pinned. `no-fixtures.test.ts` is the wall
      against plausible-but-false strings on this surface, and
      `HomeComposer.tsx` records why the invented placeholder prompt was
      deleted: a suggestion is a capability claim nobody made. An empty state
      is the easiest place to reintroduce one ("Try asking Quill to…"), so the
      absence is asserted rather than trusted.
    */
    renderConversation({ thread: [], readOnly: false });

    const pane = screen.getByText(EMPTY_TITLE).closest('[data-slot="empty"]');
    expect(pane).not.toBeNull();
    const copy = pane?.textContent ?? '';
    expect(copy).not.toMatch(/\btry\b|for example|e\.g\.|such as|you can ask/i);
    // No retired vocabulary: a back-and-forth is a chat, never a "session".
    expect(copy).not.toMatch(/session/i);
  });

  it('stays silent on a read-only empty thread — an empty excerpt may be a failed read', () => {
    /*
      THE GUARD. `readOnly` is true for every past-conversation excerpt, and a
      failed excerpt read renders `[]` with the alert above the pane carrying
      the news. Claiming "nothing here yet" here would contradict that alert
      and invent a fact about a conversation we could not read.
    */
    renderConversation({ thread: [], readOnly: true });

    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(EMPTY_DESCRIPTION)).toBeNull();
    // Nothing else crept in to fill the gap either: the pane really is blank.
    expect(document.querySelector('[data-slot="empty"]')).toBeNull();
  });

  it('stands down for a grant, because the grant is what is actually waiting', () => {
    /*
      THE SECOND GUARD, and the one that is easy to miss: the grants block
      below is gated on neither `readOnly` nor the thread. Presence admits a
      row on agent id alone, and the store is seeded at mount from
      `GET /grants` — so a grant raised on a routine fire, or left open on a
      past conversation, lands over a thread with no turns in it.

      "Send something below — Quill picks it up from there" above a card that
      is BLOCKING Quill until it is answered invites the reader to do the one
      thing that will not help. The grant speaks alone, the same way the pane
      stays blank behind a failed-excerpt alert.
    */
    renderConversation({ thread: [], readOnly: false, grants: [routedGrant] });

    // The grant really is on screen, so the missing empty state is the gate
    // and not a component that failed to render.
    expect(screen.getByTestId('thread-grants')).toBeTruthy();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(document.querySelector('[data-slot="empty"]')).toBeNull();
  });

  it('comes back once that grant is answered', () => {
    // The mirror of the test above: without this, gating on `grants` could be
    // a permanent suppression and every assertion above would still pass.
    renderConversation({ thread: [], readOnly: false, grants: [] });

    expect(screen.queryByTestId('thread-grants')).toBeNull();
    expect(screen.getByText(EMPTY_TITLE)).toBeTruthy();
  });

  it('leaves a prose-less tool turn to the step panel, and adds nothing of its own', () => {
    /*
      THE CO-EXISTENCE CHECK with #567 (TASK-352), written because the two
      changes look adjacent and are not.

      #567 drops the prose bubble when a turn has no text — a turn that only
      ran tools, where the step panel IS the reply. That test is
      `m.text.length > 0`, INSIDE `Message`, and `Message` only renders for a
      message that exists. Mine is `thread.length === 0`, i.e. whether there is
      any message at all. Different quantities, so they cannot both fire: a
      zero-turn thread never reaches `Message`, and a thread holding a
      prose-less steps turn is not zero-turn.

      Asserted rather than reasoned about. What this test does NOT assert is
      that no empty bubble is drawn — `AgentConversationSteps.test.tsx`'s
      `draws no empty bubble above a turn that only ran tools` owns that, and
      repeating it here would imply this test discriminates something it does
      not. This one pins the INTERACTION: their panel renders and my empty
      state stays out, on the one thread shape where both could plausibly fire.
    */
    const thread: ThreadMessage[] = [
      {
        kind: 'steps',
        id: 'm-1',
        text: '',
        time: '09:20',
        stepsLabel: 'Read 2 files',
        steps: [
          { text: 'Read roof-quote.pdf', status: 'done' },
          { text: 'Read notes.md', status: 'done' },
        ],
      },
    ];
    renderConversation({ thread, readOnly: false });

    // #567's half: the panel is the reply, and it is on screen.
    expect(screen.getByTestId('workspace-steps')).toBeTruthy();
    // My half: this thread has a turn in it, so it is not "nothing here yet".
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(document.querySelector('[data-slot="empty"]')).toBeNull();
  });

  it('is gone the moment the thread has anything in it', () => {
    const thread: ThreadMessage[] = [
      { kind: 'user', id: 'm-1', text: 'morning' },
      { kind: 'agent', id: 'm-2', text: 'Morning — what do you need?', time: '' },
    ];
    renderConversation({ thread, readOnly: false });

    // The turns are on screen, so a missing empty state is the state of the
    // thread rather than a component that failed to mount.
    expect(screen.getByText('morning')).toBeTruthy();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(document.querySelector('[data-slot="empty"]')).toBeNull();
  });
});
