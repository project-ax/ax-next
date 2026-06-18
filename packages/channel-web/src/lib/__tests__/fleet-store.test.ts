import { describe, it, expect } from 'vitest';
import { seedFleet, STATUS_ORDER } from '../fleet-data';
import { groupByStatus, selectVisibleAgents, type FleetState } from '../fleet-store';

function stateWith(partial: Partial<FleetState>): FleetState {
  return { agents: seedFleet(), filter: 'all', query: '', detailAgentId: null, ...partial };
}

describe('selectVisibleAgents', () => {
  it('returns everything for the "all" filter', () => {
    expect(selectVisibleAgents(stateWith({}))).toHaveLength(seedFleet().length);
  });

  it('filters by kind', () => {
    const interactive = selectVisibleAgents(stateWith({ filter: 'interactive' }));
    expect(interactive.every((a) => a.kind === 'interactive')).toBe(true);
    const workers = selectVisibleAgents(stateWith({ filter: 'worker' }));
    expect(workers.every((a) => a.kind === 'worker')).toBe(true);
  });

  it('filters to the current user with "mine"', () => {
    const mine = selectVisibleAgents(stateWith({ filter: 'mine' }));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.owner === 'mine')).toBe(true);
  });

  it('matches search against name, activity, and task id (case-insensitive)', () => {
    expect(selectVisibleAgents(stateWith({ query: 'TASK-142' }))).toHaveLength(1);
    const byActivity = selectVisibleAgents(stateWith({ query: 'auth middleware' }));
    expect(byActivity.some((a) => a.id === 'ax')).toBe(true);
  });
});

describe('groupByStatus', () => {
  it('groups in wall order and drops empty sections', () => {
    const groups = groupByStatus(seedFleet());
    const order = groups.map(([status]) => status);
    // Order must be a subsequence of STATUS_ORDER (waiting → working → error → idle).
    const indices = order.map((s) => STATUS_ORDER.indexOf(s));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    // No empty groups.
    expect(groups.every(([, list]) => list.length > 0)).toBe(true);
  });

  it('every seeded agent lands in exactly one group', () => {
    const total = groupByStatus(seedFleet()).reduce((n, [, list]) => n + list.length, 0);
    expect(total).toBe(seedFleet().length);
  });
});
