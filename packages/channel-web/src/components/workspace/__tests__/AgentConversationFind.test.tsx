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
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import { ANNOUNCE_DELAY_MS } from '../ThreadFind';
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

function conversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return (
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
      grants={[]}
      onGrantResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
      {...over}
    />
  );
}

function renderConversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return render(conversation(over));
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

/**
 * The count the READER SEES. Separate from the one a screen reader hears: the
 * announced copy is an `sr-only` live region and is debounced, so asserting on
 * it here would be asserting on a timer rather than on what is on screen.
 */
const count = (): HTMLElement => {
  const el = findBar().querySelector('[data-find-count]');
  if (!(el instanceof HTMLElement)) throw new Error('the bar shows no count');
  return el;
};

/** The count a screen reader HEARS — permanently mounted, debounced. */
const announced = (): HTMLElement => within(findBar()).getByRole('status');

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
    // No "0 matches" over a field nobody has typed in: the seen count is gone
    // entirely. The ANNOUNCED region stays mounted — it has to, to be announced
    // at all — and goes silent.
    expect(findBar().querySelector('[data-find-count]')).toBeNull();
    expect(announced().textContent).toBe('');
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

    expect(active()).toBe('0:u1');
    fireEvent.click(
      within(findBar()).getByRole('button', { name: 'Next match' }),
    );
    expect(active()).toBe('1:a1');
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

  it('finds in a read-only past conversation, not just offers to', () => {
    /*
      "Three weeks ago" is mostly a PAST conversation, so the excerpt is the
      case this card exists for. Asserting only that the BUTTON renders would
      stay green if find were ever gated behind `readOnly` — a plausible change,
      since every other control in this component is (the composer, the send
      button, the hold copy). So this runs a real query through it.

      What it deliberately does NOT claim is anything about live-vs-past
      routing: this component takes one `thread` prop and never chooses between
      them. That choice lives in `AgentView`, which this test never renders.
    */
    const { container } = renderConversation({ readOnly: true });
    openFind();
    type('deploy');
    expect(count()).toHaveTextContent('1 of 3');
    expect(container.querySelectorAll('mark')).toHaveLength(3);
  });

  it('does not drop focus on the document when the thread it searched goes away', () => {
    /*
      `AgentConversation` is mounted ONCE and un-keyed (`AgentView` swaps its
      `thread` prop between the live conversation and a past excerpt), so find
      state outlives a thread change. Open find on a real thread, click a past
      conversation in the rail, and while its excerpt is loading — or after the
      read fails — the pane holds no searchable turns at all.

      The toolbar is still up, because the open bar holds it there. But the
      moment the bar closes, the toggle Escape is supposed to hand focus back
      to goes with it, and a keyboard user is dropped on `<body>` at the top of
      the document. That is the same silent failure `use-opener-restore.ts` was
      written to fix, and it breaks the card's fourth acceptance line.
    */
    const { rerender } = renderConversation();
    const box = openFind();
    type('deploy');

    rerender(conversation({ thread: [], readOnly: true }));
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(document.activeElement).not.toBe(document.body);
    // The landing spot is NAMED, so a screen-reader user is told where they
    // have arrived rather than being teleported into an unlabelled container.
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Conversation with Quill' }),
    );
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

  it('does not quiet the composer — find is a reader\u2019s tool, not a modal', () => {
    /*
      This guard names ONE regression and goes red on it: the day someone
      writes `disabled={busy || held || findOpen}` to "focus the reader on the
      search", the composer stops taking input while the bar is open and this
      fails.

      It was briefly deleted as vacuous, on the grounds that it would also pass
      against a completely broken find. That is the wrong bar. An invariant
      guard is not measured against unrelated breakage; it is measured against
      the regression it names, and this one has a plausible author.
    */
    renderConversation();
    openFind();
    type('deploy');
    const composer = screen.getByPlaceholderText('Message Quill');
    expect(composer).not.toBeDisabled();
    fireEvent.change(composer, { target: { value: 'and now a reply' } });
    expect(composer).toHaveValue('and now a reply');
  });

  it('wires the toggle to the bar it opens', () => {
    renderConversation();
    const toggle = findButton();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(findBox()).toBeTruthy();
  });

  it('renders every turn even when two of them share an id', () => {
    /*
      The count-cannot-drift-from-the-marks claim runs through REACT, not just
      through `buildFindIndex`. With `key={m.id}` a duplicate id makes React
      drop or duplicate a `Message`, and the painted marks stop matching the
      total the index computed — the exact drift the field key exists to
      prevent, one line below the claim. Both now use `findFieldKey`.

      Duplicate ids are not reachable today (turn ids are unique, the transient
      client rows are distinct constants). This pins that nothing downstream
      depends on that staying true.
    */
    /*
      Asserting only "3 marks" would be VACUOUS here: React renders both
      children on a FIRST render even with colliding keys, and only mishandles
      them on a later reconcile — so the counts come out right either way and
      the test would pass against the very bug it names. What actually differs
      is that React complains, so that is what this watches.
    */
    const warn = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const { container } = renderConversation({
        thread: [
          { kind: 'user', id: 'same', text: 'deploy once' },
          {
            kind: 'agent',
            id: 'same',
            text: 'deploy twice deploy',
            time: '4:12 PM',
          },
        ],
      });
      openFind();
      type('deploy');

      expect(count()).toHaveTextContent('1 of 3');
      expect(container.querySelectorAll('mark')).toHaveLength(3);
      expect(
        container.querySelectorAll('mark[data-find-active="true"]'),
      ).toHaveLength(1);

      const collisions = warn.mock.calls
        .map((args) => String(args[0] ?? ''))
        .filter((line) => line.includes('same key'));
      expect(collisions).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('announces the count once the typing settles, not once per keystroke', async () => {
    /*
      `role="status"` implies `aria-atomic`, so every change re-reads the WHOLE
      region. Typing a six-letter word un-debounced queues six full readings and
      the reader hears the first one over and over. The eye gets its answer
      immediately; the ear gets it when the typing stops.
    */
    vi.useFakeTimers();
    try {
      renderConversation();
      openFind();
      type('d');
      type('de');
      type('deploy');

      // Seen at once; not yet spoken.
      expect(count()).toHaveTextContent('1 of 3');
      expect(announced().textContent).toBe('');

      await act(async () => {
        vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
      });
      expect(announced().textContent).toBe('Match 1 of 3.');
    } finally {
      vi.useRealTimers();
    }
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
