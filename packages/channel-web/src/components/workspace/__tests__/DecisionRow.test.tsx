import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DecisionRow } from '../DecisionRow';
import {
  DECISION_EXPIRED,
  DECISION_FAILED,
  DECISION_PENDING_AGENT,
} from '../decision-copy';
import { decisionFixture, resolvedFixture } from './decision-fixture';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';

const agent: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Scheduler',
  state: 'waiting',
  now: 'Waiting on your decision',
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderRow(
  d: Decision,
  expanded = true,
  over: Partial<React.ComponentProps<typeof DecisionRow>> = {},
) {
  return render(
    <DecisionRow
      decision={d}
      agent={agent}
      expanded={expanded}
      onToggle={vi.fn()}
      onOpenAgent={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      {...over}
    />,
  );
}

describe('DecisionRow — pending', () => {
  it('shows what the decision was checked against', () => {
    renderRow(decisionFixture());
    expect(
      screen.getByText(/checked against: Thursday 9:30 still free/),
    ).toBeTruthy();
  });

  it('offers the three ways out and says nothing happens yet', () => {
    renderRow(decisionFixture());
    expect(screen.getByRole('button', { name: 'Move it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick another time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeTruthy();
    expect(screen.getByText('Nothing happens until you choose')).toBeTruthy();
  });

  it('every control actually calls something — no button swallows a click', () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const onOpenAgent = vi.fn();
    renderRow(decisionFixture(), true, { onApprove, onDismiss, onOpenAgent });

    screen.getByRole('button', { name: 'Move it' }).click();
    screen.getByRole('button', { name: 'Leave it' }).click();
    screen.getByRole('button', { name: 'Pick another time' }).click();

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpenAgent).toHaveBeenCalledTimes(1);
  });
});

describe('DecisionRow — a click in flight', () => {
  it('disables the controls and says what it is doing, rather than hiding them', () => {
    // A control that VANISHES under the cursor reads as a crash. A disabled one
    // reads as "received, working on it" — which is the truth.
    renderRow(decisionFixture(), true, { busy: true });
    expect(
      (screen.getByRole('button', { name: 'Move it' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText('Working on it…')).toBeTruthy();
    expect(screen.queryByText('Nothing happens until you choose')).toBeNull();
  });

  it('shows the notice from an action that failed or was refused', () => {
    renderRow(decisionFixture(), true, {
      notice: 'We could not reach the server, so nothing changed.',
    });
    expect(screen.getByText(/could not reach the server/)).toBeTruthy();
  });
});

describe('DecisionRow — stale', () => {
  const stale = decisionFixture({
    status: 'stale',
    staleReason: 'Thursday 9:30 was booked by someone else at 11:04.',
  });

  it('leads with the fact that nothing was sent', () => {
    renderRow(stale);
    expect(screen.getByText('Nothing was sent.')).toBeTruthy();
    expect(screen.getByText(/booked by someone else at 11:04/)).toBeTruthy();
  });

  it('drops the freshness claim once the guard has disproved it', () => {
    // The label describes hold-time. Repeating "still free for both of you"
    // directly under an alert saying the slot was taken is worse than silence.
    renderRow(stale);
    expect(screen.queryByText(/checked against:/)).toBeNull();
  });

  it('re-words the primary action, because approving now means something else', () => {
    renderRow(stale);
    expect(screen.getByRole('button', { name: 'Move it anyway' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move it' })).toBeNull();
  });
});

describe('DecisionRow — resolved', () => {
  it('reports the authored approved line and offers undo inside the window', () => {
    renderRow(resolvedFixture('executed'), false);
    expect(
      screen.getByText('Scheduler moved your 1:1 with Marcus to Thursday 9:30'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('reports the authored dismissed line — never a derived one', () => {
    renderRow(resolvedFixture('dismissed'), false);
    expect(screen.getByText('You left the Marcus 1:1 where it was')).toBeTruthy();
  });

  it('drops undo once the window has closed', () => {
    renderRow(
      resolvedFixture('executed', {
        resolvedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      false,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('drops undo the moment the call has actually gone out, clock or no clock', () => {
    // The dangerous case: still inside the ten seconds, but the host already
    // made the call. `undoable: false` is the server saying so, and a button
    // offering to unsend a sent email is the worst control on this surface.
    renderRow(
      resolvedFixture('executed', { undoable: false }),
      false,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});

describe('DecisionRow — the outcomes the host cannot claim', () => {
  it('says an approved-but-unperformed action will happen NEXT RUN, never "Sent"', () => {
    const { container } = renderRow(
      resolvedFixture('approved-pending-agent'),
      false,
    );
    expect(screen.getByText(DECISION_PENDING_AGENT)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bSent\b/i);
    // And not the approved line either — that one is for a call that ran.
    expect(container.textContent).not.toContain(decisionFixture().approvedText);
  });

  it('says a failed replay completed nothing', () => {
    renderRow(resolvedFixture('failed', { undoable: false }), false);
    expect(screen.getByText(DECISION_FAILED)).toBeTruthy();
    expect(screen.getByText(/Nothing was completed/)).toBeTruthy();
  });

  it('says an expired decision simply ran out of time', () => {
    renderRow(resolvedFixture('expired', { undoable: false }), false);
    expect(screen.getByText(DECISION_EXPIRED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});
