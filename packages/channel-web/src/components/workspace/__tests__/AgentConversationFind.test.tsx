/**
 * TASK-354 — finding something in a long agent thread.
 *
 * The card's shape, and why HIGHLIGHT rather than FILTER: the acceptance says
 * zero matches must never render an empty thread, because an empty thread reads
 * as "this agent never said anything" — the H7 class of defect `AgentFiles`
 * spends a whole header avoiding. A filter has to remember to special-case
 * that. A highlight cannot produce it at all, so the invariant is structural
 * rather than remembered, and the zero-match pin below proves the WHOLE thread
 * is still on screen, not merely that a sentence appeared.
 *
 * This is deliberately NOT a port of chat's `SearchBar` / `search-store.ts`.
 * Those never filtered anything — `search-store.ts` says so in its own header
 * ("actual message-text filtering is deferred") — so porting them would have
 * ported an affordance that lies.
 *
 * Every count assertion is scoped INSIDE the find bar. This component already
 * renders a second `role="status"` node (the composer's approval announcer), so
 * an unscoped `getByRole('status')` matches two elements and the suite fails for
 * a reason that has nothing to do with find.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import { decisionFixture } from './decision-fixture';

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const USER_LINE = 'can you deploy the site tonight';
const AGENT_LINE = 'deploy finished — the deploy took 4s';
const QUIET_LINE = 'nothing else to report';

const thread: ThreadMessage[] = [
  { kind: 'user', id: 'u1', text: USER_LINE },
  { kind: 'agent', id: 'a1', text: AGENT_LINE, time: '4:12 PM' },
  { kind: 'agent', id: 'a2', text: QUIET_LINE, time: '4:13 PM' },
];

function renderConversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return render(
    <AgentConversation
      agent={quill}
      thread={thread}
      decisions={[]}
      readOnly={false}
      onSend={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      approvalRead="ok"
      onRetryApprovals={vi.fn()}
      {...over}
    />,
  );
}

const findButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Find' });

const findBar = (): HTMLElement => {
  const id = findButton().getAttribute('aria-controls');
  const region = id === null ? null : document.getElementById(id);
  if (region === null) throw new Error('the find bar is not open');
  return region;
};

const findBox = (): HTMLElement =>
  within(findBar()).getByRole('textbox', { name: 'Find in this conversation' });

/** The bar's own live count — scoped, see the header. */
const count = (): HTMLElement => within(findBar()).getByRole('status');

function openFind(): HTMLElement {
  fireEvent.click(findButton());
  return findBox();
}

function type(value: string): void {
  fireEvent.change(findBox(), { target: { value } });
}

describe('finding something in an agent thread', () => {
  it('shows how many turns matched, and marks every one of them', () => {
    const { container } = renderConversation();
    openFind();
    type('deploy');

    // Three occurrences: one in the question, two in the answer.
    expect(count()).toHaveTextContent('1 of 3');
    expect(container.querySelectorAll('mark')).toHaveLength(3);
  });

  it('never reports a count it did not paint', () => {
    /*
      The bar's number and the marks on screen come from one function. This is
      the pin that keeps them there: a second, "smarter" matcher in the
      renderer would tell the reader there are four and show three.
    */
    const { container } = renderConversation();
    openFind();
    type('o');
    const reported = Number(
      /of (\d+)/.exec(count().textContent ?? '')?.[1],
    );
    expect(reported).toBeGreaterThan(0);
    expect(container.querySelectorAll('mark')).toHaveLength(reported);
  });

  it('says nothing matched, and leaves the whole thread on screen', () => {
    const { container } = renderConversation();
    openFind();
    type('kubernetes');

    expect(count()).toHaveTextContent('No matches');
    // THE H7 PIN. Every turn is still readable — the thread was not emptied.
    expect(screen.getByText(USER_LINE)).toBeTruthy();
    expect(screen.getByText(AGENT_LINE)).toBeTruthy();
    expect(screen.getByText(QUIET_LINE)).toBeTruthy();
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('restores the thread exactly when the query is cleared', () => {
    const { container } = renderConversation();
    openFind();
    type('deploy');
    expect(container.querySelectorAll('mark').length).toBeGreaterThan(0);

    type('');
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(within(findBar()).queryByRole('status')).toBeNull();
    expect(screen.getByText(USER_LINE)).toBeTruthy();
    expect(screen.getByText(AGENT_LINE)).toBeTruthy();
    expect(screen.getByText(QUIET_LINE)).toBeTruthy();
  });

  it('walks forward and back through the matches, wrapping at both ends', () => {
    renderConversation();
    openFind();
    type('deploy');
    const next = within(findBar()).getByRole('button', { name: 'Next match' });
    const prev = within(findBar()).getByRole('button', {
      name: 'Previous match',
    });

    expect(count()).toHaveTextContent('1 of 3');
    fireEvent.click(next);
    expect(count()).toHaveTextContent('2 of 3');
    fireEvent.click(next);
    expect(count()).toHaveTextContent('3 of 3');
    // Off the end, back to the top.
    fireEvent.click(next);
    expect(count()).toHaveTextContent('1 of 3');
    // And off the top, round to the end.
    fireEvent.click(prev);
    expect(count()).toHaveTextContent('3 of 3');
  });

  it('moves the current-match marker as the reader walks', () => {
    const { container } = renderConversation();
    openFind();
    type('deploy');

    const active = (): string | null =>
      container
        .querySelector('mark[data-find-active="true"]')
        ?.getAttribute('data-find-field') ?? null;

    expect(active()).toBe('u1');
    fireEvent.click(
      within(findBar()).getByRole('button', { name: 'Next match' }),
    );
    expect(active()).toBe('a1');
    // Exactly one at a time — two "current" marks is no current mark.
    expect(
      container.querySelectorAll('mark[data-find-active="true"]'),
    ).toHaveLength(1);
  });

  it('is fully operable from the keyboard', () => {
    renderConversation();
    const box = openFind();
    // The bar takes focus on open, so a keyboard user lands where they type.
    expect(document.activeElement).toBe(box);

    type('deploy');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(count()).toHaveTextContent('2 of 3');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(count()).toHaveTextContent('1 of 3');
  });

  it('closes on Escape and hands focus back to what opened it', () => {
    renderConversation();
    const box = openFind();
    type('deploy');

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(
      screen.queryByRole('textbox', { name: 'Find in this conversation' }),
    ).toBeNull();
    expect(document.activeElement).toBe(findButton());
  });

  it('takes its highlights away when it closes', () => {
    // Closing with a query still set would leave the thread painted with no
    // count on screen to explain why.
    const { container } = renderConversation();
    const box = openFind();
    type('deploy');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('does not offer a find control over a thread with nothing to find', () => {
    renderConversation({ thread: [] });
    expect(screen.queryByRole('button', { name: 'Find' })).toBeNull();
  });

  it('offers find on a read-only past conversation too', () => {
    // "Three weeks ago" is mostly a PAST conversation, so the excerpt is the
    // case this card exists for.
    renderConversation({ readOnly: true });
    expect(findButton()).toBeTruthy();
  });

  it('does not count the words on an approval card', () => {
    /*
      An approval card is drawn from the GLOBAL decisions queue, not from the
      thread, and a pointer whose row has not landed renders nothing at all. A
      count that included those words would move when an unrelated fetch did.
    */
    const decision = decisionFixture({ id: 'd1', summary: 'Deploy the site?' });
    const { container } = renderConversation({
      thread: [
        { kind: 'user', id: 'u1', text: USER_LINE },
        { kind: 'approval', id: 'p1', decisionId: 'd1' },
      ],
      decisions: [decision],
    });
    openFind();
    type('deploy');

    expect(count()).toHaveTextContent('1 of 1');
    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });

  it('does not count the thinking placeholder while a reply streams', () => {
    renderConversation({
      thread: [
        {
          kind: 'agent',
          id: 'a1',
          text: 'thinking about the deploy',
          time: '4:12 PM',
        },
        { kind: 'status', id: 'pending-status', text: 'Thinking…' },
      ],
    });
    openFind();
    type('thinking');
    expect(count()).toHaveTextContent('1 of 1');
  });

  it('keeps the composer usable while the bar is open', () => {
    // The find bar is a reader's tool, not a modal. Typing into it must not
    // quiet the thing the user came here to do.
    renderConversation();
    openFind();
    type('deploy');
    expect(screen.getByPlaceholderText('Message Quill')).not.toBeDisabled();
  });

  it('wires the toggle to the bar it opens', () => {
    renderConversation();
    const toggle = findButton();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(findBox()).toBeTruthy();
  });

  it('does not offer navigation it cannot perform', () => {
    renderConversation();
    openFind();
    type('kubernetes');
    const bar = within(findBar());
    expect(bar.getByRole('button', { name: 'Next match' })).toBeDisabled();
    expect(bar.getByRole('button', { name: 'Previous match' })).toBeDisabled();
  });
});
