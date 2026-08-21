import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DecisionRow } from '../DecisionRow';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';

const agent: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Scheduler',
  role: 'Guards your calendar',
  icon: 'calendar-days',
  state: 'waiting',
  channel: 'routine',
  now: 'Waiting on your decision',
  counter: null,
  startedAt: null,
  stoppedReason: null,
  paused: false,
  footer: '',
};

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd-marcus',
    agentId: 'scheduler',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'unattended',
    status: 'pending',
    call: { id: 'call-1', name: 'calendar__move_event', input: {} },
    freshness: {
      kind: 'slot-etag',
      value: 'etag-free',
      label: 'Thursday 9:30 still free for both of you',
    },
    summary: 'Move your 1:1 with Marcus to Thursday 9:30?',
    detail: 'It clashes with the board prep.',
    preview: null,
    primaryLabel: 'Move it',
    secondaryLabel: 'Pick another time',
    ghostLabel: 'Leave it',
    approvedText: 'Scheduler moved your 1:1 with Marcus to Thursday 9:30',
    dismissedText: 'You left the Marcus 1:1 where it was',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    resolvedAt: null,
    staleReason: null,
    ...over,
  };
}

function renderRow(d: Decision, expanded = true) {
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
    />,
  );
}

describe('DecisionRow — pending', () => {
  it('shows what the decision was checked against', () => {
    renderRow(decision());
    expect(
      screen.getByText(/checked against: Thursday 9:30 still free/),
    ).toBeTruthy();
  });

  it('offers the three ways out and says nothing happens yet', () => {
    renderRow(decision());
    expect(screen.getByRole('button', { name: 'Move it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick another time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeTruthy();
    expect(screen.getByText('Nothing happens until you choose')).toBeTruthy();
  });
});

describe('DecisionRow — stale', () => {
  const stale = decision({
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
    renderRow(
      decision({ status: 'executed', resolvedAt: new Date().toISOString() }),
      false,
    );
    expect(
      screen.getByText('Scheduler moved your 1:1 with Marcus to Thursday 9:30'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('reports the authored dismissed line — never a derived one', () => {
    renderRow(
      decision({ status: 'dismissed', resolvedAt: new Date().toISOString() }),
      false,
    );
    expect(screen.getByText('You left the Marcus 1:1 where it was')).toBeTruthy();
  });

  it('drops undo once the window has closed', () => {
    renderRow(
      decision({
        status: 'executed',
        resolvedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      false,
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});
