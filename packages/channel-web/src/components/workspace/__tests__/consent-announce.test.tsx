/**
 * ANSWERING A CONSENT SURFACE MUST BE ANNOUNCED (TASK-442).
 *
 * The other half of TASK-427. That card moved FOCUS onto the card's own answer,
 * and `consent-focus.test.tsx` proves it lands: a sighted keyboard user sees the
 * receipt and reaches Undo in one Tab. Landing focus on a node is not the same
 * as announcing it, though, and the gap is not academic:
 *
 *   - the second line of a receipt (`outcome.note` — "Nothing has happened yet.
 *     Undo stops it before it runs.") sits OUTSIDE the focused node in both
 *     renderers, so nothing reads it at all; and
 *   - focus only moves when THIS person's click produced the answer
 *     (`armForResolution`). Any answer that arrives another way — the deferred
 *     "about to go ahead" turning into "it has gone out" when the grace period
 *     closes — changes the card in silence.
 *
 * So both renderers now mount ONE live region, and these tests are about the
 * three ways that mechanism can be built wrong while still looking right:
 *
 *   1. A REGION THAT ARRIVES WITH ITS MESSAGE ALREADY INSIDE is not reliably
 *      announced — assistive tech has nothing to have observed changing. This
 *      is the failure mode a conditional `<p role="alert">{notice}</p>` has, and
 *      it is invisible to jsdom: the node is right there in the tree either way.
 *      Every case below therefore asserts NODE IDENTITY across the transition —
 *      the region the message appears in has to be the same DOM node that was
 *      already sitting there empty. That assertion is what fails against a
 *      conditionally-rendered alert.
 *   2. A REGION THAT SPEAKS ON MOUNT. `InThreadApprovals` draws the last ten
 *      seconds of settled receipts above the composer on every page load;
 *      reading those out is telling someone something happened when nothing
 *      just did. The region is silent until something CHANGES.
 *   3. A REGION SHARING A NODE WITH THE COUNTDOWN. `role="alert"` implies
 *      `aria-atomic`, so any mutation re-reads the WHOLE region, and a resolved
 *      row re-renders `Undo · Ns` twice a second off `useDecisionClock` — up to
 *      ten spurious readings of a receipt that has not changed. The countdown
 *      case below advances real timers and asserts the visible countdown moved
 *      while the announcement did not, so it cannot pass by the clock simply
 *      never ticking.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard } from '../ApprovalCard';
import { DecisionRow } from '../DecisionRow';
import {
  DECISION_GOING_OUT,
  DECISION_GOING_OUT_NOTE,
  DECISION_STALE_ADVICE,
  DECISION_STALE_LEAD,
  DECISION_UNDO_TOO_LATE,
} from '../decision-copy';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';

const quill: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/**
 * One of the card's two live regions, by the attribute the shared component
 * marks it with (TASK-540): `receipt` is the assertive one that says an
 * ANSWER, `open` the polite one that says what an open card picked up while
 * nobody pressed anything (a stale reason, a notice).
 *
 * NOT `getByRole('alert')`: until TASK-535, `DecisionRow`'s open branch drew
 * its stale reason and failed-POST notice inside shadcn's `Alert` WITH the
 * `role="alert"` shadcn gives it, and a role query would have been satisfied by
 * one of those. They have given the role up (the region is the one voice), but
 * the attribute stays the query: it names the node this file is about rather
 * than whichever live region happens to be on the page. The politeness IS
 * asserted — on the node that speaks, in the cases that make it speak.
 */
type Voice = 'receipt' | 'open';

function region(voice: Voice): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-consent-said="${voice}"]`);
  if (el === null) {
    throw new Error(`no ${voice} consent announcement region is mounted on this card`);
  }
  return el;
}

/** What a screen reader would have just been handed, by that region. */
function said(voice: Voice): string {
  return region(voice).textContent ?? '';
}

/**
 * How loudly a region speaks. `role="alert"` is assertive and `role="status"`
 * polite by definition; the explicit `aria-live` is pinned too, because an
 * explicit attribute outranks the role's implicit value — a stray
 * `aria-live="assertive"` on a status node would make it interrupt.
 */
function politeness(el: HTMLElement): string {
  return `${el.getAttribute('role')}/${el.getAttribute('aria-live')}`;
}
const ASSERTIVE = 'alert/assertive';
const POLITE = 'status/polite';

/** The in-thread card, driven the way `useConversationDecisions` drives it. */
function ThreadHarness({ resolved }: { resolved: Decision }) {
  const [d, setD] = useState<Decision>(decisionFixture());
  return (
    <ApprovalCard
      decision={d}
      onApprove={() => setD(resolved)}
      onDismiss={() => setD(resolved)}
      onUndo={vi.fn()}
    />
  );
}

/** The Today row, driven the way `useDecisionQueue` drives it. */
function QueueHarness({ resolved }: { resolved: Decision }) {
  const [d, setD] = useState<Decision>(decisionFixture());
  return (
    <DecisionRow
      decision={d}
      agent={quill}
      expanded
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={() => setD(resolved)}
      onDismiss={() => setD(resolved)}
      onUndo={vi.fn()}
    />
  );
}

/** A resolved row whose Undo the server refuses when it is pressed. */
function RefusedUndoHarness({ renderer }: { renderer: 'thread' | 'queue' }) {
  const [notice, setNotice] = useState<string | null>(null);
  const d = resolvedFixture('executed');
  const refuse = () => setNotice(DECISION_UNDO_TOO_LATE);
  return renderer === 'thread' ? (
    <ApprovalCard
      decision={d}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={refuse}
      notice={notice}
    />
  ) : (
    <DecisionRow
      decision={d}
      agent={quill}
      expanded
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={refuse}
      notice={notice}
    />
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ['ApprovalCard', 'thread'],
  ['DecisionRow', 'queue'],
] as const)('%s announces what it says back', (_name, renderer) => {
  const Harness = ({ resolved }: { resolved: Decision }) =>
    renderer === 'thread' ? (
      <ThreadHarness resolved={resolved} />
    ) : (
      <QueueHarness resolved={resolved} />
    );

  it('saying yes announces the receipt, in a region that was already there', () => {
    const resolved = resolvedFixture('executed');
    render(<Harness resolved={resolved} />);

    // Mounted, empty, and waiting — the only shape assistive tech reliably
    // announces a later change in.
    const before = region('receipt');
    expect(said('receipt')).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(said('receipt')).toBe(resolved.approvedText);
    // THE LOAD-BEARING ASSERTION. A conditionally-rendered alert would put the
    // same words on screen and fail here, because its node did not exist a
    // moment ago.
    expect(region('receipt')).toBe(before);
    // The answer to the person's own press, inside a ten-second undo window:
    // said assertively, and by that region alone.
    expect(politeness(before)).toBe(ASSERTIVE);
    expect(said('open')).toBe('');
  });

  it('announces the quiet second line too — the part focus never reads', () => {
    /*
      `outcome.note` is a sibling of the focused node in both renderers, so the
      TASK-427 landing cannot carry it. It is also the line that says nothing
      has happened yet, which is the whole content of the ten seconds.
    */
    render(
      <Harness
        resolved={resolvedFixture('executed', {
          irreversible: true,
          pendingUntil: new Date(Date.now() + 10_000).toISOString(),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(said('receipt')).toBe(`${DECISION_GOING_OUT} ${DECISION_GOING_OUT_NOTE}`);
  });

  it('a REFUSED undo is announced, on a row that is otherwise unchanged', () => {
    /*
      The one case where a notice lands on an ALREADY RESOLVED row: the window
      shut between the click and the request landing. The receipt does not
      change, the Undo button simply goes — so without this the person is told
      nothing at all about a take-back that did not happen.
    */
    render(<RefusedUndoHarness renderer={renderer} />);

    const before = region('receipt');
    expect(said('receipt')).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));

    expect(said('receipt')).toBe(DECISION_UNDO_TOO_LATE);
    expect(region('receipt')).toBe(before);
    // A notice on a RESOLVED row is still the answer to a press, so it keeps
    // the receipt's politeness (TASK-540 changes only the open branch).
    expect(politeness(before)).toBe(ASSERTIVE);
    expect(said('open')).toBe('');
  });

  it('a receipt drawn on page load announces nothing', () => {
    /*
      THE FAIL-OPEN DIRECTION, and the reason the region is not simply given
      the current sentence on mount. `InThreadApprovals` renders every receipt
      resolved in the last ten seconds above the composer on a plain page load;
      a region that read them out would announce a past event as news — the
      audible version of the focus theft `useResolutionFocus`'s arming exists
      to prevent.
    */
    const resolved = resolvedFixture('executed');
    render(
      renderer === 'thread' ? (
        <ApprovalCard
          decision={resolved}
          onApprove={vi.fn()}
          onDismiss={vi.fn()}
          onUndo={vi.fn()}
        />
      ) : (
        <DecisionRow
          decision={resolved}
          agent={quill}
          expanded
          onToggle={vi.fn()}
          onOpenAgent={vi.fn()}
          onApprove={vi.fn()}
          onDismiss={vi.fn()}
          onUndo={vi.fn()}
        />
      ),
    );

    // The receipt IS on screen — this is not a case of nothing having rendered.
    expect(screen.getByText(resolved.approvedText)).toBeTruthy();
    expect(said('receipt')).toBe('');
  });

  it('the ten-second countdown does not re-announce the receipt', () => {
    /*
      `role="alert"` implies `aria-atomic`: any mutation inside the region
      re-reads all of it. A resolved row re-renders twice a second while Undo
      is alive, so a region sharing a node with the countdown would read the
      receipt out up to ten times — burying the one reading that mattered.
    */
    vi.useFakeTimers();
    render(<Harness resolved={resolvedFixture('executed')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    const announced = said('receipt');
    const before = region('receipt');
    const countdown = screen.getByRole('button', { name: /Undo/ }).textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    // The clock REALLY ticked — without this the case would pass on a card
    // that simply never re-rendered.
    expect(screen.getByRole('button', { name: /Undo/ }).textContent).not.toBe(
      countdown,
    );
    expect(said('receipt')).toBe(announced);
    expect(region('receipt')).toBe(before);
  });

  it('the region is assertive, and invisible', () => {
    /*
      ASSERTIVE, not polite, and the undo window is the whole argument: the
      answer is worth interrupting for precisely because the control that
      reverses it expires in ten seconds. A polite announcement queued behind
      whatever the reader was saying can spend a meaningful part of that.

      `sr-only` rather than `hidden`: `display:none` takes the node straight
      back out of the accessibility tree, which would undo the fix while
      looking like it. It is absolutely positioned, so it is not a flex item
      and adds no gap to the containers these cards sit in.
    */
    render(<Harness resolved={resolvedFixture('executed')} />);

    expect(politeness(region('receipt'))).toBe(ASSERTIVE);
    expect(region('receipt').className).toContain('sr-only');
    // Its polite sibling (TASK-540) is mounted from the start too, for the
    // same reason, and just as invisible.
    expect(politeness(region('open'))).toBe(POLITE);
    expect(region('open').className).toContain('sr-only');
  });
});

/* ------------------------------------------------------------------ *
 * THE OPEN BRANCH, ON PASSIVE ARRIVAL (TASK-473)
 *
 * Everything above is about an ANSWER. This is about the card while it is
 * still a question, and about the changes to it that nobody on this page
 * clicked for: a queue read that brings back `status: 'stale'` because another
 * tab approved it, a notice set with no press behind it. `armForResolution`
 * only runs from an `onClick`, so the TASK-427 focus landing never fires for
 * those — whatever voice the card has, it has to be a live region.
 *
 * The two renderers answer differently, and both answers are pinned:
 *
 *   - `ApprovalCard` draws the stale reason and the notice as plain
 *     paragraphs, so the shared region says them — in the node that was
 *     already there, which is the assertion a relocated or conditionally
 *     mounted region fails.
 *   - `DecisionRow` draws them inside shadcn's `Alert`, and only while the
 *     row is EXPANDED — collapsed, the Today default, it draws nothing. So
 *     the shared region says them there too (TASK-535), and the `Alert`s give
 *     up their own `role="alert"` so that it stays ONE voice, expanded or
 *     collapsed.
 *
 * POLITELY, since TASK-540. The human ruling on TASK-275 is that a card which
 * changes because of the agent is announced politely and focus does not move.
 * The receipt region's reason for interrupting — a ten-second undo window —
 * does not exist on an open card, so these sentences go out through the
 * card's OTHER region, the polite one, and every case that makes it speak
 * pins its politeness and that the assertive region stayed empty.
 *
 * WHICH DIRECTION DOES THIS FAIL IN? Silent — open. A region created in the
 * same commit as its sentence reads correctly to jsdom and says nothing to
 * real assistive tech, so text alone passes against the broken shape. Node
 * identity is what fails it.
 * ------------------------------------------------------------------ */

const STALE_REASON = 'Thursday 9:30 was booked by someone else at 11:04.';
const STALE_SENTENCE = `${DECISION_STALE_LEAD} ${STALE_REASON} ${DECISION_STALE_ADVICE}`;
const staleFixture = () =>
  decisionFixture({ status: 'stale', staleReason: STALE_REASON });

type OpenChange = { decision: Decision; notice: string | null };

/**
 * Either renderer, driven from OUTSIDE — the shape a server push or a queue
 * read takes. No button on the card is pressed, so nothing is armed.
 */
function Passive({
  renderer,
  change,
  expanded = true,
}: {
  renderer: 'thread' | 'queue';
  change: OpenChange | null;
  /** The queue row only. Collapsed is the Today default. */
  expanded?: boolean;
}) {
  const d = change?.decision ?? decisionFixture();
  const notice = change?.notice ?? null;
  return renderer === 'thread' ? (
    <ApprovalCard
      decision={d}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      notice={notice}
    />
  ) : (
    <DecisionRow
      decision={d}
      agent={quill}
      expanded={expanded}
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      notice={notice}
    />
  );
}

/**
 * Every live region on the page — assertive or polite — whose words include
 * `text`. Both politenesses, so that moving a sentence from one region to the
 * other cannot leave a copy behind in the first unnoticed.
 */
function voicesSaying(text: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"], [aria-live]'),
  ).filter((el) => (el.textContent ?? '').includes(text));
}

/** The open branch spoke through the polite region, and only through it. */
function spokePolitely(before: HTMLElement) {
  expect(politeness(before)).toBe(POLITE);
  expect(said('receipt')).toBe('');
}

describe('ApprovalCard — the open branch speaks when it changes on its own', () => {
  it('a card that goes stale while on screen says so, in the region already there', () => {
    const { rerender } = render(<Passive renderer="thread" change={null} />);
    const before = region('open');
    expect(said('open')).toBe('');

    rerender(
      <Passive renderer="thread" change={{ decision: staleFixture(), notice: null }} />,
    );

    expect(said('open')).toBe(STALE_SENTENCE);
    // THE LOAD-BEARING ASSERTION — see the block header.
    expect(region('open')).toBe(before);
    spokePolitely(before);
    // And only once: the paragraph on screen is not a second live region.
    expect(voicesSaying(STALE_REASON)).toEqual([before]);
  });

  it('a notice that arrives with no press behind it is said', () => {
    const notice = 'That did not go through. Nothing was sent.';
    const { rerender } = render(<Passive renderer="thread" change={null} />);
    const before = region('open');

    rerender(
      <Passive renderer="thread" change={{ decision: decisionFixture(), notice }} />,
    );

    expect(said('open')).toBe(notice);
    expect(region('open')).toBe(before);
    spokePolitely(before);
    expect(voicesSaying(notice)).toEqual([before]);
  });

  it('a notice outranks the stale reason it lands on, as it does for focus', () => {
    const notice = 'That did not go through. Nothing was sent.';
    const { rerender } = render(
      <Passive renderer="thread" change={{ decision: staleFixture(), notice: null }} />,
    );

    rerender(
      <Passive renderer="thread" change={{ decision: staleFixture(), notice }} />,
    );

    expect(said('open')).toBe(notice);
    spokePolitely(region('open'));
  });

  it('a notice that clears empties the region, so the same refusal later is news again', () => {
    const notice = 'That did not go through. Nothing was sent.';
    const { rerender } = render(
      <Passive renderer="thread" change={{ decision: decisionFixture(), notice }} />,
    );
    const before = region('open');

    rerender(<Passive renderer="thread" change={null} />);
    expect(said('open')).toBe('');

    rerender(
      <Passive renderer="thread" change={{ decision: decisionFixture(), notice }} />,
    );
    expect(said('open')).toBe(notice);
    expect(region('open')).toBe(before);
  });

  it('an undo that re-opens a receipt clears what the region last said', () => {
    const resolved = resolvedFixture('executed');
    const { rerender } = render(
      <Passive renderer="thread" change={{ decision: decisionFixture(), notice: null }} />,
    );
    const before = region('receipt');

    rerender(<Passive renderer="thread" change={{ decision: resolved, notice: null }} />);
    expect(said('receipt')).toBe(resolved.approvedText);

    rerender(<Passive renderer="thread" change={{ decision: decisionFixture(), notice: null }} />);
    expect(said('receipt')).toBe('');
    expect(said('open')).toBe('');
    expect(region('receipt')).toBe(before);
  });

  it('a stale card that then resolves hands over to the assertive region', () => {
    /*
      Both regions stay mounted across the open-to-resolved swap — the swap
      renders an entirely different subtree, which is exactly why the regions
      hang above the branch split. The polite one empties as the receipt
      goes out, so a reader moving through the page does not find the stale
      sentence still sitting beside an answer that superseded it.
    */
    const resolved = resolvedFixture('executed');
    const { rerender } = render(<Passive renderer="thread" change={null} />);
    const open = region('open');
    const receipt = region('receipt');

    rerender(
      <Passive renderer="thread" change={{ decision: staleFixture(), notice: null }} />,
    );
    expect(said('open')).toBe(STALE_SENTENCE);

    rerender(<Passive renderer="thread" change={{ decision: resolved, notice: null }} />);
    expect(said('receipt')).toBe(resolved.approvedText);
    expect(politeness(receipt)).toBe(ASSERTIVE);
    expect(said('open')).toBe('');
    expect(region('open')).toBe(open);
    expect(region('receipt')).toBe(receipt);
  });

  it('a card that MOUNTS stale stays quiet — the mount rule does not bend', () => {
    /*
      An INVARIANT GUARD, not evidence for the fix: it passes on the code
      before TASK-473 too. What it catches is the plausible wrong fix —
      seeding the region from the current open sentence instead of from
      silence.
    */
    /*
      A page load. The hold's arrival is `InThreadApprovals`' polite line to
      say, and a region created holding its sentence is the unreliable shape
      this component avoids everywhere else.
    */
    render(
      <Passive renderer="thread" change={{ decision: staleFixture(), notice: null }} />,
    );

    expect(screen.getByText(DECISION_STALE_LEAD)).toBeTruthy();
    expect(said('open')).toBe('');
    expect(said('receipt')).toBe('');
  });
});

/*
 * TASK-535. The Today row, collapsed and expanded. Before this card the row
 * handed the region `openNote={null}` because its `Alert`s were already
 * `role="alert"` — but those only mount EXPANDED, so a collapsed row (the
 * default) that went stale or picked up a notice said nothing at all.
 *
 * Every case is a `rerender` with new props and no click: `armForResolution`
 * runs only from `onClick`, so a click would move focus and hide a missing
 * voice. Focus is asserted to stay where it was — TASK-275: an arrival nobody
 * pressed for is said, not jumped to.
 */
describe.each([
  ['collapsed', false],
  ['expanded', true],
] as const)('DecisionRow (%s) — the open branch is said once, by the shared region', (_label, expanded) => {
  it('going stale on screen is said, in the region already there, with no focus move', () => {
    const { rerender } = render(
      <Passive renderer="queue" change={null} expanded={expanded} />,
    );
    const before = region('open');
    const focused = document.activeElement;
    expect(said('open')).toBe('');

    rerender(
      <Passive
        renderer="queue"
        change={{ decision: staleFixture(), notice: null }}
        expanded={expanded}
      />,
    );

    expect(said('open')).toBe(STALE_SENTENCE);
    // THE LOAD-BEARING ASSERTION — see the block header above.
    expect(region('open')).toBe(before);
    spokePolitely(before);
    // ONE voice: the visible `Alert` (expanded) is not a second live region.
    expect(voicesSaying(STALE_REASON)).toEqual([before]);
    expect(document.activeElement).toBe(focused);
  });

  it('a notice that arrives with no press behind it is said once, with no focus move', () => {
    const notice = 'That did not go through. Nothing was sent.';
    const { rerender } = render(
      <Passive renderer="queue" change={null} expanded={expanded} />,
    );
    const before = region('open');
    const focused = document.activeElement;

    rerender(
      <Passive
        renderer="queue"
        change={{ decision: decisionFixture(), notice }}
        expanded={expanded}
      />,
    );

    expect(said('open')).toBe(notice);
    expect(region('open')).toBe(before);
    spokePolitely(before);
    expect(voicesSaying(notice)).toEqual([before]);
    expect(document.activeElement).toBe(focused);
  });

  it('a notice outranks the stale reason it lands on', () => {
    const notice = 'That did not go through. Nothing was sent.';
    const { rerender } = render(
      <Passive
        renderer="queue"
        change={{ decision: staleFixture(), notice: null }}
        expanded={expanded}
      />,
    );

    rerender(
      <Passive
        renderer="queue"
        change={{ decision: staleFixture(), notice }}
        expanded={expanded}
      />,
    );

    expect(said('open')).toBe(notice);
    spokePolitely(region('open'));
  });

  it('a stale row that then resolves hands over to the assertive region', () => {
    const resolved = resolvedFixture('executed');
    const { rerender } = render(
      <Passive renderer="queue" change={null} expanded={expanded} />,
    );
    const open = region('open');
    const receipt = region('receipt');

    rerender(
      <Passive
        renderer="queue"
        change={{ decision: staleFixture(), notice: null }}
        expanded={expanded}
      />,
    );
    expect(said('open')).toBe(STALE_SENTENCE);

    rerender(
      <Passive
        renderer="queue"
        change={{ decision: resolved, notice: null }}
        expanded={expanded}
      />,
    );
    expect(said('receipt')).toBe(resolved.approvedText);
    expect(politeness(receipt)).toBe(ASSERTIVE);
    expect(said('open')).toBe('');
    expect(region('open')).toBe(open);
    expect(region('receipt')).toBe(receipt);
  });

  it('a row that MOUNTS stale stays quiet, and so does its Alert', () => {
    /*
      An INVARIANT GUARD for the mount rule. On an expanded row it is also
      evidence for the fix: before TASK-535 the stale `Alert` mounted with
      `role="alert"` holding its sentence, a page-load announcement.
    */
    render(
      <Passive
        renderer="queue"
        change={{ decision: staleFixture(), notice: null }}
        expanded={expanded}
      />,
    );

    expect(said('open')).toBe('');
    expect(voicesSaying(STALE_REASON)).toEqual([]);
  });
});

describe('DecisionRow — opening and closing a stale row is not news', () => {
  it('toggling a stale row says nothing new, and does not move the region', () => {
    /*
      The plausible wrong fix is `openNote={expanded ? null : sentence}`,
      which would re-announce the stale reason every time someone collapsed
      the row. The note must not depend on the disclosure.
    */
    const change = { decision: staleFixture(), notice: null };
    const { rerender } = render(
      <Passive renderer="queue" change={null} expanded={false} />,
    );
    const before = region('open');
    rerender(<Passive renderer="queue" change={change} expanded={false} />);
    expect(said('open')).toBe(STALE_SENTENCE);

    // A toggle-dependent note would empty the region here, and say the
    // sentence again on the collapse below.
    rerender(<Passive renderer="queue" change={change} expanded />);
    expect(said('open')).toBe(STALE_SENTENCE);
    expect(region('open')).toBe(before);
    rerender(<Passive renderer="queue" change={change} expanded={false} />);
    expect(said('open')).toBe(STALE_SENTENCE);
    expect(region('open')).toBe(before);
    expect(voicesSaying(STALE_REASON)).toEqual([before]);
  });
});
