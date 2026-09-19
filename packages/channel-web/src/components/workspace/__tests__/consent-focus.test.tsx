/**
 * ANSWERING A CONSENT SURFACE MUST NOT DROP FOCUS ON `<body>` (TASK-427).
 *
 * Found by a manual-acceptance walk. Resolving a grant or a decision replaced
 * the controls with a receipt, the focused button went with them, and the
 * browser's answer to that is `<body>` — the top of the document. The receipt
 * carries a TEN-SECOND Undo (`UNDO_WINDOW_MS`), so from `<body>` on a real page
 * the only control that can take back an irreversible action was roughly ten
 * blind Tabs away and the window shut before it could be reached. That is why
 * these tests assert REACHABILITY and not merely "focus moved": a landing that
 * still leaves Undo ten Tabs out fixes nothing.
 *
 * THE FOUR SITES THE WALK MEASURED, each with its own case below:
 *
 *   1. `ApprovalCard` — yes, in-thread.
 *   2. `ApprovalCard` — no, in-thread.
 *   3. `DecisionRow` — yes, in the Today queue.
 *   4. the host grant's "Not now" — on BOTH renderers of it, because there are
 *      two: `GrantRow` (the workspace) and `PermissionCard` (the `/` chat tree
 *      TASK-360 retires). Fixing only the named one would have left the live
 *      surface broken.
 *
 * AND UNDO HAS TWO ENDINGS. It can succeed — the row goes back to `pending` —
 * or the server can REFUSE it, because the window shut between the click and
 * the request landing. A refusal is the one case where a notice arrives on a
 * row that is already RESOLVED, so an outcome-first key would never notice it.
 * Both endings are driven below.
 *
 * AND TAKING IT BACK IS AN ANSWER TOO. Undo inside the window returns the row
 * to `pending` (`decisions/machine.ts`), so the receipt AND the Undo button
 * both unmount — the classic way to strand focus, on the one control this
 * whole change exists to make reachable. The full keyboard journey is driven
 * below: approve, land on the receipt, Tab to Undo, press it, land on the
 * question.
 *
 * AND THE ANSWER THAT IS NOT A RESOLUTION. Approving a row whose freshness
 * guard trips does NOT resolve it: `decisions/machine.ts` hands back a row that
 * is still open, `status: 'stale'`, and the card re-opens as a question with a
 * new sentence at the top. No receipt, no Undo, controls still on screen — and
 * it is the PRIMARY action of a consent surface. Covered here for
 * `ApprovalCard` and `DecisionRow`, including twice in a row.
 *
 * THE DECOYS ARE THE POINT. Every harness here puts a handful of tabbable
 * elements BEFORE the card, the way a real page has a nav above its content.
 * Without them `<body>` and the right answer are indistinguishable — the card
 * is the only thing in the document, so Undo is one Tab from anywhere — and the
 * test would pass against the bug.
 *
 * WHAT THESE TESTS CANNOT SEE, stated so the coverage is not overread. In a
 * real browser, disabling the element that currently has focus blurs it to
 * `<body>` — which is how a `disabled={busy}` button loses focus the instant it
 * is clicked, before any receipt renders. jsdom does not model that (measured:
 * focus stays on the button across a `busy` re-render), so these harnesses
 * resolve synchronously and cannot distinguish "focus was restored after a trip
 * through `<body>`" from "focus never left". The END STATE is what is asserted,
 * and it is the same either way — but a failure path that restores nothing is
 * invisible here, which is why every branch that leaves a card on screen gets
 * an explicit case below rather than being argued about.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import { AgentConversation } from '../AgentConversation';
import { ApprovalCard } from '../ApprovalCard';
import { DecisionRow } from '../DecisionRow';
import { GrantRow } from '../GrantRow';
import { TodayView } from '../TodayView';
import { Composer } from '@/components/Composer';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import { grantKey } from '@/lib/workspace-grant-store';
import { permissionCardActions } from '@/lib/permission-card-store';
import {
  GRANT_CONNECT_LABEL,
  GRANT_NOT_RESUMED,
  GRANT_REJECT_LABEL,
  HOST_ALLOW_ONCE_LABEL,
} from '@/lib/grant-copy';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import type { PermissionRequest } from '@/server/types';

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

/**
 * Everything a Tab press can land on, in document order.
 *
 * Deliberately crude — it is not a full `tabbable` implementation and does not
 * need to be. jsdom computes no layout, so visibility cannot be consulted; what
 * it CAN do faithfully is document order and the two exclusions that decide
 * this question, `disabled` and `tabindex="-1"`.
 */
function tabbables(root: ParentNode = document.body): HTMLElement[] {
  const sel = 'a[href], button, input, select, textarea, [tabindex]';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1',
  );
}

/**
 * How many Tab presses separate the CURRENTLY FOCUSED element from `target`.
 *
 * This is the property the card is actually about. On `<body>` the count is
 * every tabbable on the page that precedes the control; from the receipt it is
 * 1. `Infinity` when the target is not ahead of focus at all.
 *
 * A DESCENDANT of the focused element reports `FOLLOWING` too, so checking that
 * one bit is enough to catch Undo INSIDE the outcome container. (The DOM sets
 * `CONTAINED_BY` alongside it; this filter does not need to ask for it, and
 * deliberately does not.) That is exactly the tab order being measured: moving
 * on from a `tabIndex={-1}` container goes into its own children first, which
 * is how Undo ends up one Tab from the outcome line.
 */
function tabsToReach(target: HTMLElement): number {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
  const ahead = tabbables().filter(
    (el) =>
      el !== active &&
      (active.compareDocumentPosition(el) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
  );
  const i = ahead.indexOf(target);
  return i < 0 ? Number.POSITIVE_INFINITY : i + 1;
}

/** Roughly the nav a real page puts above the card — see the file header. */
function Decoys(): ReactNode {
  return (
    <nav>
      {['Home', 'Agents', 'Today', 'Files', 'Memory', 'Settings'].map((n) => (
        <button key={n} type="button">
          {n}
        </button>
      ))}
    </nav>
  );
}

const DECOY_COUNT = 6;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const quill: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const hostReq: PermissionRequest = {
  kind: 'host',
  host: 'api.linear.app',
  sessionId: 's-1',
};

const skillReq: PermissionRequest = {
  kind: 'skill',
  skillId: 'linear-issues',
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' }],
};

/** `Composer` draws assistant-ui primitives, which want a runtime in context. */
function ChatStub({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({
    async run() {
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

/** The in-thread card, driven the way `useConversationDecisions` drives it. */
function ThreadHarness({ resolved }: { resolved: Decision }) {
  const [d, setD] = useState<Decision>(decisionFixture());
  return (
    <div>
      <Decoys />
      <ApprovalCard
        decision={d}
        onApprove={() => setD(resolved)}
        onDismiss={() => setD(resolved)}
        onUndo={vi.fn()}
      />
    </div>
  );
}

/** The Today row, driven the way `useDecisionQueue` drives it. */
function QueueHarness({ resolved }: { resolved: Decision }) {
  const [d, setD] = useState<Decision>(decisionFixture());
  return (
    <div>
      <Decoys />
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
    </div>
  );
}

const undoButton = () => screen.getByRole('button', { name: /Undo/ });

afterEach(() => {
  vi.restoreAllMocks();
  permissionCardActions.dismiss();
});

/* ------------------------------------------------------------------ *
 * 1 + 2 — ApprovalCard, in-thread
 * ------------------------------------------------------------------ */

describe('ApprovalCard — in-thread (sites 1 and 2)', () => {
  it('site 1: saying yes lands focus on the receipt, with Undo one Tab away', () => {
    render(<ThreadHarness resolved={resolvedFixture('executed')} />);

    const yes = screen.getByRole('button', { name: 'Move it' });
    yes.focus();
    fireEvent.click(yes);

    // The bug, stated plainly. On `main` this is the body element.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByTestId('approval-outcome-d-marcus'),
    );
    // And the property that actually matters: the ten-second control is one
    // keystroke from where we were put. On `main` it was DECOY_COUNT + 1.
    expect(tabsToReach(undoButton())).toBe(1);
  });

  it('site 2: saying no lands focus on the receipt too', () => {
    render(<ThreadHarness resolved={resolvedFixture('dismissed')} />);

    const no = screen.getByRole('button', { name: 'Leave it' });
    no.focus();
    fireEvent.click(no);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByTestId('approval-outcome-d-marcus'),
    );
    expect(tabsToReach(undoButton())).toBe(1);
  });

  it('measures what the bug cost: from <body> the same Undo is many Tabs out', () => {
    // The counter-measurement, so the numbers above are not taken on faith.
    // This is precisely the state `main` left the page in.
    render(<ThreadHarness resolved={resolvedFixture('executed')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    (document.activeElement as HTMLElement | null)?.blur();

    expect(document.activeElement).toBe(document.body);
    expect(tabsToReach(undoButton())).toBe(DECOY_COUNT + 1);
  });

  it('an ATTENDED decision has no Undo to reach, and still gets the receipt', () => {
    // The deferral predicate is `!attended && hasExecutor && irreversible`, so
    // an attended row is handed straight back to the agent with no grace
    // period — `undoable` is false and there is no button. The landing is not
    // pointless there: it is the only place the outcome sentence is announced,
    // and the alternative is still `<body>`.
    render(
      <ThreadHarness
        resolved={resolvedFixture('executed', {
          attendance: 'attended',
          undoable: false,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByTestId('approval-outcome-d-marcus'),
    );
  });

  it('the whole keyboard journey: approve \u2192 receipt \u2192 Tab \u2192 Undo \u2192 question', () => {
    /*
      The end-to-end version of this card, and the one path that must not
      strand anybody: undoing returns the row to `pending`, which unmounts the
      receipt AND the Undo button the person was standing on. Without a landing
      they are on `<body>` in front of a re-opened question — having used the
      exact control this change exists to make reachable.
    */
    function UndoableHarness() {
      const open = decisionFixture();
      const [d, setD] = useState<Decision>(open);
      return (
        <div>
          <Decoys />
          <ApprovalCard
            decision={d}
            onApprove={() => setD(resolvedFixture('executed'))}
            onDismiss={vi.fn()}
            // What the server really answers an undo with: the original,
            // open, unresolved row (`machine.ts` \u2192 status 'pending').
            onUndo={() => setD(open)}
          />
        </div>
      );
    }
    render(<UndoableHarness />);

    const yes = screen.getByRole('button', { name: 'Move it' });
    yes.focus();
    fireEvent.click(yes);

    // One Tab from here reaches Undo \u2014 the property the card is about.
    expect(tabsToReach(undoButton())).toBe(1);

    fireEvent.click(undoButton());

    // The row is a question again \u2014 and we are standing on it, not on <body>.
    expect(screen.getByRole('button', { name: 'Move it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByTestId('approval-question-d-marcus'),
    );
  });

  it('a REFUSED undo focuses the line saying it was too late', () => {
    /*
      The second ending of Undo, and the one an outcome-first key cannot see:
      the server refuses (`DECISION_UNDO_TOO_LATE` — the window shut between
      the click and the request landing), so the row stays exactly as resolved
      as it was and the ONLY thing that changes is a red line. The Undo button
      is gone by then, so there is nothing left where the person was standing.
    */
    function RefusedUndoHarness() {
      const [notice, setNotice] = useState<string | null>(null);
      return (
        <div>
          <Decoys />
          <ApprovalCard
            decision={resolvedFixture('executed')}
            onApprove={vi.fn()}
            onDismiss={vi.fn()}
            onUndo={() => setNotice('That had already happened.')}
            notice={notice}
          />
        </div>
      );
    }
    render(<RefusedUndoHarness />);

    const undo = undoButton();
    undo.focus();
    fireEvent.click(undo);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe(
      'That had already happened.',
    );
    // Still resolved — the refusal changed nothing but the sentence.
    expect(screen.getByTestId('approval-d-marcus').dataset.status).toBe(
      'executed',
    );
  });

  it('approving into a STALE re-open focuses the sentence that says so', () => {
    // The guard tripped: nothing was executed, the row is still open, the
    // buttons are still there, and the only thing that changed is a line at
    // the top. There is no receipt to land on — and without this the person is
    // on `<body>` in front of a card that looks unchanged.
    render(
      <ThreadHarness
        resolved={decisionFixture({
          status: 'stale',
          staleReason: 'Thursday 9:30 is no longer free.',
          freshness: {
            kind: 'slot-etag',
            value: 'etag-moved',
            label: null,
          },
        })}
      />,
    );

    const yes = screen.getByRole('button', { name: 'Move it' });
    yes.focus();
    fireEvent.click(yes);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain(
      'Thursday 9:30 is no longer free.',
    );
    // Still a question, not a receipt — the controls are the proof.
    expect(screen.getByRole('button', { name: 'Move it anyway' })).toBeTruthy();
  });

  it('lands AGAIN when a second approve comes back stale a second time', () => {
    /*
      The case a boolean "does it have an answer yet" flag cannot serve: it
      only fires on the false-to-true edge, so the second stale answer in a row
      gets no landing at all. `useResolutionFocus` keys on the answer's TEXT
      instead, and the machine re-captures `freshness.value` on every trip of
      the guard (it has to, or approving again would bounce forever), so two
      consecutive stale answers can never carry the same key.
    */
    function TwiceStaleHarness() {
      const [d, setD] = useState<Decision>(decisionFixture());
      const staleAs = (value: string, why: string) =>
        decisionFixture({
          status: 'stale',
          staleReason: why,
          freshness: { kind: 'slot-etag', value, label: null },
        });
      return (
        <div>
          <Decoys />
          <ApprovalCard
            decision={d}
            onApprove={() =>
              setD(
                d.status === 'stale'
                  ? staleAs('etag-3', 'It moved again while you were reading.')
                  : staleAs('etag-2', 'Thursday 9:30 is no longer free.'),
              )
            }
            onDismiss={vi.fn()}
            onUndo={vi.fn()}
          />
        </div>
      );
    }
    render(<TwiceStaleHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    expect(document.activeElement?.textContent).toContain(
      'Thursday 9:30 is no longer free.',
    );

    // Second go. Blur first, so a landing that never happens reads as `<body>`
    // rather than as the previous one still being in place.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Move it anyway' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain(
      'It moved again while you were reading.',
    );
  });

  it('a receipt drawn on page load does NOT steal focus', () => {
    // `InThreadApprovals` renders the last ten seconds of settled rows above
    // the composer on every load. Grabbing focus for one nobody just acted on
    // would be this fix pointed the wrong way.
    render(
      <div>
        <Decoys />
        <ApprovalCard
          decision={resolvedFixture('executed')}
          onApprove={vi.fn()}
          onDismiss={vi.fn()}
          onUndo={vi.fn()}
        />
      </div>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('a resolve that did NOT land focuses the notice instead of nothing', () => {
    // The POST failed, the row stays open, and the person is left standing on
    // `<body>` with an unread error behind them — the same bug, minus the
    // receipt. The notice is the card's answer, so it takes the focus.
    function FailHarness() {
      const [notice, setNotice] = useState<string | null>(null);
      return (
        <div>
          <Decoys />
          <ApprovalCard
            decision={decisionFixture()}
            onApprove={() => setNotice('We could not reach the server.')}
            onDismiss={vi.fn()}
            onUndo={vi.fn()}
            notice={notice}
          />
        </div>
      );
    }
    render(<FailHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe(
      'We could not reach the server.',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3 — DecisionRow, in the Today queue
 * ------------------------------------------------------------------ */

describe('DecisionRow — the Today queue (site 3)', () => {
  it('site 3: saying yes lands focus on the receipt, with Undo one Tab away', () => {
    render(<QueueHarness resolved={resolvedFixture('executed')} />);

    const yes = screen.getByRole('button', { name: 'Move it' });
    yes.focus();
    fireEvent.click(yes);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByTestId('decision-outcome-d-marcus'),
    );
    expect(tabsToReach(undoButton())).toBe(1);
  });

  it('a resolve that did NOT land focuses the row\u2019s notice Alert', () => {
    // `DecisionRow` renders its notice as an `Alert`, not a `<p>` as
    // `ApprovalCard` does, so the ref lands on a different node and needs its
    // own case — dropping it there would otherwise pass on the card's test.
    function FailQueueHarness() {
      const [notice, setNotice] = useState<string | null>(null);
      return (
        <div>
          <Decoys />
          <DecisionRow
            decision={decisionFixture()}
            agent={quill}
            expanded
            onToggle={vi.fn()}
            onOpenAgent={vi.fn()}
            onApprove={() => setNotice('We could not reach the server.')}
            onDismiss={vi.fn()}
            onUndo={vi.fn()}
            notice={notice}
          />
        </div>
      );
    }
    render(<FailQueueHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('a REFUSED undo on the queue row focuses the same line', () => {
    // Same second ending, on the row whose receipt-branch notice is a
    // paragraph rather than a span.
    function RefusedUndoQueueHarness() {
      const [notice, setNotice] = useState<string | null>(null);
      return (
        <div>
          <Decoys />
          <DecisionRow
            decision={resolvedFixture('executed')}
            agent={quill}
            expanded
            onToggle={vi.fn()}
            onOpenAgent={vi.fn()}
            onApprove={vi.fn()}
            onDismiss={vi.fn()}
            onUndo={() => setNotice('That had already happened.')}
            notice={notice}
          />
        </div>
      );
    }
    render(<RefusedUndoQueueHarness />);

    fireEvent.click(undoButton());

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe(
      'That had already happened.',
    );
    expect(screen.getByTestId('decision-d-marcus').dataset.status).toBe(
      'executed',
    );
  });

  it('undo re-opens the queue row and lands on the row\u2019s own question', () => {
    // Same journey on the queue row. Its question is the disclosure button,
    // whose accessible name IS the question — so landing there reads it back,
    // and it keeps its place in the Tab order because it is a real control.
    function UndoableQueueHarness() {
      const open = decisionFixture();
      const [d, setD] = useState<Decision>(open);
      return (
        <div>
          <Decoys />
          <DecisionRow
            decision={d}
            agent={quill}
            expanded
            onToggle={vi.fn()}
            onOpenAgent={vi.fn()}
            onApprove={() => setD(resolvedFixture('executed'))}
            onDismiss={vi.fn()}
            onUndo={() => setD(open)}
          />
        </div>
      );
    }
    render(<UndoableQueueHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    expect(tabsToReach(undoButton())).toBe(1);

    fireEvent.click(undoButton());

    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Move your 1:1 with Marcus/ }),
    );
    // The disclosure must stay reachable by Tab — `tabIndex={-1}` here would
    // buy the landing at the cost of the control.
    expect(
      (document.activeElement as HTMLElement).getAttribute('tabindex'),
    ).toBeNull();
  });

  it('approving into a STALE re-open focuses the row\u2019s stale Alert', () => {
    // Same answer-that-is-not-a-resolution as the in-thread card, on the queue
    // row, where the sentence is an `Alert` rather than a paragraph.
    render(
      <QueueHarness
        resolved={decisionFixture({
          status: 'stale',
          staleReason: 'Thursday 9:30 is no longer free.',
          freshness: { kind: 'slot-etag', value: 'etag-moved', label: null },
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(document.activeElement?.textContent).toContain(
      'Thursday 9:30 is no longer free.',
    );
    expect(screen.getByRole('button', { name: 'Move it anyway' })).toBeTruthy();
  });

  it('lands AGAIN when the queue row comes back stale a second time', () => {
    /*
      The queue row's twin of the in-thread twice-stale case, and NOT a
      duplicate: `open:${d.status}` already changes on pending -> stale, so a
      build with no stale branch in `answerKey` at all still passes the
      single-stale test above (measured — that mutant survived until this case
      existed). It is the SECOND stale in a row, where the status does not
      change, that the stale branch is actually load-bearing for.
    */
    function TwiceStaleQueueHarness() {
      const [d, setD] = useState<Decision>(decisionFixture());
      const staleAs = (value: string, why: string) =>
        decisionFixture({
          status: 'stale',
          staleReason: why,
          freshness: { kind: 'slot-etag', value, label: null },
        });
      return (
        <div>
          <Decoys />
          <DecisionRow
            decision={d}
            agent={quill}
            expanded
            onToggle={vi.fn()}
            onOpenAgent={vi.fn()}
            onApprove={() =>
              setD(
                d.status === 'stale'
                  ? staleAs('etag-3', 'It moved again while you were reading.')
                  : staleAs('etag-2', 'Thursday 9:30 is no longer free.'),
              )
            }
            onDismiss={vi.fn()}
            onUndo={vi.fn()}
          />
        </div>
      );
    }
    render(<TwiceStaleQueueHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    expect(document.activeElement?.textContent).toContain(
      'Thursday 9:30 is no longer free.',
    );

    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Move it anyway' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain(
      'It moved again while you were reading.',
    );
  });

  it('saying no lands focus on the receipt as well', () => {
    render(<QueueHarness resolved={resolvedFixture('dismissed')} />);
    const no = screen.getByRole('button', { name: 'Leave it' });
    no.focus();
    fireEvent.click(no);

    expect(document.activeElement).toBe(
      screen.getByTestId('decision-outcome-d-marcus'),
    );
    expect(tabsToReach(undoButton())).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4 — the host grant's "Not now", on both renderers
 * ------------------------------------------------------------------ */

describe('the host grant turned down (site 4)', () => {
  it('GrantRow hands focus to the consent region the surface declares', () => {
    // A grant that is turned down leaves NOTHING behind — no receipt, no Undo,
    // the row is gone. So the landing is the region above it, which has to
    // outlive the row; `TodayView` is what actually declares it, and this is
    // the row's half of that contract.
    const onResolved = vi.fn();
    render(
      <div>
        <Decoys />
        <div data-consent-region="" tabIndex={-1} role="group" aria-label="Your queue">
          <GrantRow
            grant={{
              key: grantKey(hostReq),
              request: hostReq,
              conversationId: 'c1',
              agentId: 'scheduler',
            }}
            onResolved={onResolved}
            onGranted={vi.fn(async () => true)}
          />
        </div>
      </div>,
    );

    const notNow = screen.getByRole('button', { name: GRANT_REJECT_LABEL });
    notNow.focus();
    fireEvent.click(notNow);

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(document.body);
    expect(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
    ).toBe('Your queue');
  });

  it('TodayView declares a region that SURVIVES the last grant being answered', () => {
    /*
      THE HALF THAT IS EASY TO GET WRONG — and easy to write a test that misses.

      A region rendered inside the `grants.length > 0` gate unmounts with the
      row it was meant to catch, and focus goes straight back to `<body>`. But
      Today's list card is gated on `readable || working || (needs && grants)`,
      so on a HEALTHY queue the card survives the last grant anyway and a
      NESTED region would pass this test regardless. The first version of this
      case did exactly that; the mutation run is what caught it.

      So the queue is driven UNREADABLE here. That is the one state where the
      grant is the only thing holding the list card up ("GRANTS SURVIVE AN
      UNREADABLE QUEUE", over in `TodayView`), answering it takes the card down
      with it, and a region tucked inside the gate is the difference between
      landing somewhere and landing on `<body>`.
    */
    function TodayHarness() {
      const [grants, setGrants] = useState([
        {
          key: grantKey(hostReq),
          request: hostReq,
          conversationId: 'c1',
          agentId: 'scheduler',
        },
      ]);
      return (
        <div>
          <Decoys />
          <TodayView
            decisions={[]}
            grants={grants}
            onGrantResolved={() => setGrants([])}
            onGranted={vi.fn(async () => true)}
            agents={[quill]}
            filter="needs"
            expandedId={null}
            onExpand={vi.fn()}
            onOpenAgent={vi.fn()}
            onApprove={vi.fn()}
            onDismiss={vi.fn()}
            onUndo={vi.fn()}
            onSeeActivity={vi.fn()}
            error={{ kind: 'failed', detail: 'queue read blew up' }}
          />
        </div>
      );
    }
    const { container } = render(<TodayHarness />);

    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    // The list card really did come down — without this the case above is not
    // the case under test, just a healthy queue wearing its name.
    expect(container.querySelector('[data-testid^="grant-"]')).toBeNull();
    expect(container.querySelector('.rounded-lg.border.bg-card')).toBeNull();
    const region = container.querySelector('[data-consent-region]');
    expect(region).not.toBeNull();
    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('AgentConversation declares one that survives the last grant too', () => {
    // The agent thread is the SECOND place `GrantRow` is drawn (TASK-351), and
    // its grants box is gated on `grants.length > 0` exactly as Today's list
    // is. Same trap, same assertion, so a region tucked inside that gate here
    // cannot pass on Today's test alone.
    function ThreadGrantHarness() {
      const [grants, setGrants] = useState([
        {
          key: grantKey(hostReq),
          request: hostReq,
          conversationId: 'c1',
          agentId: 'scheduler',
        },
      ]);
      return (
        <div>
          <Decoys />
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
            grants={grants}
            onGrantResolved={() => setGrants([])}
            onGranted={vi.fn(async () => true)}
          />
        </div>
      );
    }
    const { container } = render(<ThreadGrantHarness />);

    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    expect(screen.queryByTestId('thread-grants')).toBeNull();
    const region = container.querySelector('[data-consent-region]');
    expect(region).not.toBeNull();
    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('GrantRow focuses its failure Alert when the grant does NOT land', async () => {
    // The row stays, the button comes back, and in a real browser the focus the
    // `disabled` took is gone. `GrantRow` says something back here, so the
    // thing it says takes the focus.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(
      <div>
        <Decoys />
        <div data-consent-region="" tabIndex={-1} role="group" aria-label="Your queue">
          <GrantRow
            grant={{
              key: grantKey(hostReq),
              request: hostReq,
              conversationId: 'c1',
              agentId: 'scheduler',
            }}
            onResolved={vi.fn()}
            onGranted={vi.fn(async () => true)}
          />
        </div>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: HOST_ALLOW_ONCE_LABEL }));

    /*
      WAIT FOR THE FOCUS, NOT FOR THE ALERT (TASK-388). Waiting on the alert's
      EXISTENCE and then asserting focus in the next statement is a race the
      product legitimately loses: `useResolutionFocus` moves focus from a
      `useEffect`, so there is a window where the alert is committed and the
      effect that focuses it has not run. Measured at 2 failures in 15 local
      runs before this change — and it is the assertion, not the product, that
      was early: the focus does land, one tick later.

      The invariant is unchanged and still pinned — focus ends up on the alert
      and not on `<body>`. Only the deadline moved.
    */
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it('GrantRow focuses the line saying the agent did not start again', async () => {
    // The THIRD ending (TASK-374): the capability landed, the agent did not
    // pick up, and the row turns into one sentence about exactly that. It is
    // still an answer, so it still takes the focus.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    render(
      <div>
        <Decoys />
        <div data-consent-region="" tabIndex={-1} role="group" aria-label="Your queue">
          <GrantRow
            grant={{
              key: grantKey(skillReq),
              request: skillReq,
              conversationId: 'c1',
              agentId: 'scheduler',
            }}
            onResolved={vi.fn()}
            onGranted={vi.fn(async () => false)}
          />
        </div>
      </div>,
    );

    fireEvent.change(screen.getByLabelText(/API key/i), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: GRANT_CONNECT_LABEL }));

    const line = await screen.findByTestId('grant-not-resumed');
    expect(line.textContent).toBe(GRANT_NOT_RESUMED);
    expect(document.activeElement).toBe(line);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('PermissionCard focuses its failure Alert when the grant does NOT land', async () => {
    // The finding a reviewer caught: success unmounts the card and `close()`
    // hands focus up, but a FAILED Allow leaves the card on screen with the
    // person on `<body>` and the Alert unread behind them. Same bug, quieter.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(
      <ChatStub>
        <Decoys />
        <Composer />
      </ChatStub>,
    );
    permissionCardActions.show(hostReq);

    const allow = await screen.findByRole('button', {
      name: HOST_ALLOW_ONCE_LABEL,
    });
    allow.focus();
    fireEvent.click(allow);

    // Same race as the `GrantRow` case above, latent here rather than
    // observed — same renderer-independent cause (focus arrives from an
    // effect), so it gets the same deadline rather than waiting its turn to
    // start failing.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    });
    // The card is still up — this is the failure path, not the dismiss path.
    expect(screen.getByTestId('permission-card-host')).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('PermissionCard hands focus to the composer stack on the `/` surface', async () => {
    // The OTHER renderer of the same question. `PermissionCard` is the one the
    // card body names; `GrantRow` above is the one the walk's surface draws.
    // Both had the hole, so both are pinned — and this one goes through the
    // real `Composer`, so the region is the shipped markup rather than the
    // test's own.
    const { container } = render(
      <ChatStub>
        <Decoys />
        <Composer />
      </ChatStub>,
    );
    permissionCardActions.show(hostReq);

    const notNow = await screen.findByRole('button', {
      name: GRANT_REJECT_LABEL,
    });
    notNow.focus();
    fireEvent.click(notNow);

    await waitFor(() => {
      expect(screen.queryByTestId('permission-card-host')).toBeNull();
    });
    const region = container.querySelector('[data-consent-region]');
    expect(region).not.toBeNull();
    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);
  });
});
