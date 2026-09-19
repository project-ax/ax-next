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
 * The card's live region, by the attribute the shared component marks it with.
 *
 * NOT `getByRole('alert')`: `DecisionRow`'s open branch renders a stale reason
 * and a failed-POST notice inside shadcn's `Alert`, which carries `role="alert"`
 * of its own. A role query would be satisfied by one of those and would say
 * nothing about the region this card is for. The role IS asserted — once, on
 * this node, in its own case below.
 */
function region(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-consent-said]');
  if (el === null) {
    throw new Error('no consent announcement region is mounted on this card');
  }
  return el;
}

/** What a screen reader would have just been handed. */
function said(): string {
  return region().textContent ?? '';
}

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
    const before = region();
    expect(said()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(said()).toBe(resolved.approvedText);
    // THE LOAD-BEARING ASSERTION. A conditionally-rendered alert would put the
    // same words on screen and fail here, because its node did not exist a
    // moment ago.
    expect(region()).toBe(before);
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

    expect(said()).toBe(`${DECISION_GOING_OUT} ${DECISION_GOING_OUT_NOTE}`);
  });

  it('a REFUSED undo is announced, on a row that is otherwise unchanged', () => {
    /*
      The one case where a notice lands on an ALREADY RESOLVED row: the window
      shut between the click and the request landing. The receipt does not
      change, the Undo button simply goes — so without this the person is told
      nothing at all about a take-back that did not happen.
    */
    render(<RefusedUndoHarness renderer={renderer} />);

    const before = region();
    expect(said()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));

    expect(said()).toBe(DECISION_UNDO_TOO_LATE);
    expect(region()).toBe(before);
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
    expect(said()).toBe('');
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
    const announced = said();
    const before = region();
    const countdown = screen.getByRole('button', { name: /Undo/ }).textContent;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    // The clock REALLY ticked — without this the case would pass on a card
    // that simply never re-rendered.
    expect(screen.getByRole('button', { name: /Undo/ }).textContent).not.toBe(
      countdown,
    );
    expect(said()).toBe(announced);
    expect(region()).toBe(before);
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

    expect(region().getAttribute('role')).toBe('alert');
    expect(region().className).toContain('sr-only');
  });
});
