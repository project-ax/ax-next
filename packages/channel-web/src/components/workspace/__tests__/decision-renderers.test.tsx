/**
 * ONE ROW, THREE RENDERERS — the invariant, pinned.
 *
 * `DecisionRow` (the Today queue) and `ApprovalCard` (the in-thread card) draw
 * the same `Decision`. Slack will be the third. They are allowed to differ in
 * LAYOUT — one is a scannable line that expands, the other is a card inside a
 * conversation. They are not allowed to differ in what they SAY about an
 * outcome, because then a person who approves something in the thread and then
 * opens Today reads two different accounts of one event, and learns to trust
 * neither.
 *
 * So these tests render both from the same fixture and compare the strings.
 * `decision-copy.ts` is what makes them agree; this is what proves they still do.
 *
 * The row that matters most is `approved-pending-agent`. It is a REAL approval
 * for an action that HAS NOT HAPPENED — the host cannot make the call itself and
 * the agent will do it on its next run. Both renderers say exactly that, and
 * neither of them says "Sent".
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalCard } from '../ApprovalCard';
import { DecisionRow } from '../DecisionRow';
import {
  DECISION_EXPIRED,
  DECISION_FAILED,
  DECISION_GOING_OUT,
  DECISION_PENDING_AGENT,
  DECISION_STALE_LEAD,
} from '../decision-copy';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';

const agent: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Scheduler',
  state: 'waiting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/** What the queue row says about this decision. */
function queueText(d: Decision): string {
  const { container, unmount } = render(
    <DecisionRow
      decision={d}
      agent={agent}
      expanded
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
    />,
  );
  const text = container.textContent ?? '';
  unmount();
  return text;
}

/** What the in-thread card says about the same one. */
function cardText(d: Decision): string {
  const { container, unmount } = render(
    <ApprovalCard
      decision={d}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
    />,
  );
  const text = container.textContent ?? '';
  unmount();
  return text;
}

describe('one row, three renderers — the outcome line', () => {
  const cases: Array<{ name: string; decision: Decision; line: string }> = [
    {
      name: 'executed',
      decision: resolvedFixture('executed'),
      line: decisionFixture().approvedText,
    },
    {
      name: 'approved-pending-agent',
      decision: resolvedFixture('approved-pending-agent'),
      line: DECISION_PENDING_AGENT,
    },
    {
      name: 'dismissed',
      decision: resolvedFixture('dismissed'),
      line: decisionFixture().dismissedText,
    },
    {
      name: 'failed',
      decision: resolvedFixture('failed', { undoable: false }),
      line: DECISION_FAILED,
    },
    {
      name: 'expired',
      decision: resolvedFixture('expired', { undoable: false }),
      line: DECISION_EXPIRED,
    },
  ];

  for (const c of cases) {
    it(`says the same thing in both places — ${c.name}`, () => {
      const inQueue = queueText(c.decision);
      const inThread = cardText(c.decision);
      expect(inQueue).toContain(c.line);
      expect(inThread).toContain(c.line);
    });
  }

  it('never claims an unattended-parked approval was sent', () => {
    // The one sentence this whole surface exists to get right. The host CANNOT
    // make this call; the approval stands and the agent performs it later.
    const parked = resolvedFixture('approved-pending-agent');
    for (const text of [queueText(parked), cardText(parked)]) {
      expect(text).toContain(DECISION_PENDING_AGENT);
      expect(text).not.toMatch(/\bSent\b/i);
      expect(text).not.toContain(parked.approvedText);
    }
  });

  it('does not say an irreversible action has happened while it is still deferred', () => {
    const deferred = resolvedFixture('executed', {
      irreversible: true,
      pendingUntil: new Date(Date.now() + 9_000).toISOString(),
    });
    for (const text of [queueText(deferred), cardText(deferred)]) {
      expect(text).toContain(DECISION_GOING_OUT);
      // `approvedText` is the "it went out" sentence. Not yet, it hasn't.
      expect(text).not.toContain(deferred.approvedText);
      expect(text).toMatch(/Undo/);
    }
  });

  it('shows the same three authored labels on an open row', () => {
    const open = decisionFixture();
    // The card drops `secondaryLabel` — there is nowhere for "open the agent"
    // to go from inside the agent's own thread — so the two agree on the two
    // labels that resolve the decision, which are the ones that matter.
    for (const text of [queueText(open), cardText(open)]) {
      expect(text).toContain(open.primaryLabel);
      expect(text).toContain(open.ghostLabel);
      expect(text).toContain(open.summary);
    }
  });

  it('re-words the primary action on a stale row in both places', () => {
    const stale = decisionFixture({
      status: 'stale',
      staleReason: 'Thursday 9:30 was booked by someone else at 11:04.',
    });
    for (const text of [queueText(stale), cardText(stale)]) {
      expect(text).toContain('Move it anyway');
      expect(text).toContain(DECISION_STALE_LEAD);
      expect(text).toContain('booked by someone else at 11:04');
    }
  });
});

/*
  The queue is read once and then updated by the responses to a person's own
  clicks — there is no poll. So anything a row says that stops being true on a
  CLOCK has to change itself, or the screen quietly keeps making a claim nobody
  is checking any more (design H7).

  Two of those, and they close together: the undo window, and whether a deferred
  irreversible action has actually gone ahead.
*/
describe('a row that changes on its own', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops saying an action is about to happen once it has happened', () => {
    vi.useFakeTimers();
    /*
      `pendingUntil` is deliberately LATER than the undo window closes. The two
      normally land together — the deferral IS the window — but the row reads
      the server's instant against the browser's clock, and those two machines
      do not agree to the second. With even a little skew the countdown finishes
      first, and a row that only re-rendered while the countdown was running
      would freeze on "it is about to go ahead" and stay there for as long as
      the tab was open.
    */
    const deferred = resolvedFixture('executed', {
      irreversible: true,
      resolvedAt: new Date().toISOString(),
      pendingUntil: new Date(Date.now() + 20_000).toISOString(),
    });
    const { container } = render(
      <DecisionRow
        decision={deferred}
        agent={agent}
        expanded={false}
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(DECISION_GOING_OUT);

    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    // The undo window has closed; the action still has not happened, and the
    // row still says so rather than reporting an outcome nobody has observed.
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(container.textContent).toContain(DECISION_GOING_OUT);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // It went ahead. The row says the authored approved line now.
    expect(container.textContent).not.toContain(DECISION_GOING_OUT);
    expect(container.textContent).toContain(deferred.approvedText);
  });
});

describe('the undo affordance', () => {
  it('is offered while the server says the row can still be taken back', () => {
    render(
      <ApprovalCard
        decision={resolvedFixture('executed')}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('is NOT offered once the call has actually been made', () => {
    // `undoable: false` is the server's answer, and it is the gate that matters:
    // the ten-second clock has not run out here, but the email has already gone.
    // Offering "Undo" would promise something we cannot do.
    render(
      <ApprovalCard
        decision={resolvedFixture('executed', { undoable: false })}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});
