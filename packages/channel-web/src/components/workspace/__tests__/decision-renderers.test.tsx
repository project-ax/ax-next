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
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalCard } from '../ApprovalCard';
import { DecisionRow } from '../DecisionRow';
import {
  DECISION_EXPIRED,
  DECISION_FAILED,
  DECISION_GOING_OUT,
  DECISION_PENDING_AGENT,
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
      expect(text).toContain('Nothing was sent.');
      expect(text).toContain('booked by someone else at 11:04');
    }
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
