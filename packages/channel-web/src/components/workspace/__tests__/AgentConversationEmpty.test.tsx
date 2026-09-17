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

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
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
