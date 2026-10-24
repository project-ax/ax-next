import { describe, it, expect } from 'vitest';
import * as C from '@ax/routines-contract';
import { routineView } from '../services.js';
import type { StoredRoutine } from '../types.js';

// TASK-910: a routine's next run, as every view shows it, is when it will
// really run. The tick skips a run that falls outside the routine's active
// hours and re-arms it at the next window's start, so a stored time outside the
// window is a time nothing will happen. The task page reads this as "Next check".
const NINE_TO_SIX = { start: '09:00', end: '18:00', tz: 'UTC' } as const;
function stored(nextRunAt: string | null, activeHours: C.ActiveHours | null = NINE_TO_SIX): StoredRoutine {
  return {
    ...C.RoutineDefinitionSchema.parse({ name: 'Notify', promptBody: 'Do the thing', trigger: { kind: 'interval', every: '1h' }, activeHours }),
    agentId: 'agent', routineId: 'routine', revision: 'revision', ownerUserId: 'owner',
    definitionId: null, definitionUpdatedAt: null, nextRunAt: nextRunAt === null ? null : new Date(nextRunAt), lastRunAt: null,
    lastStatus: null, lastError: null, lastWarning: null, task: null, noRecentUpdate: null, steps: [],
  };
}
const nextRunAt = (row: StoredRoutine) => routineView(row, 'owner', true).nextRunAt;

describe("a routine's next run honours its active hours (TASK-910)", () => {
  it("moves a next run after the day's window to the next morning", () => {
    expect(nextRunAt(stored('2030-01-01T18:30:00Z'))).toBe('2030-01-02T09:00:00.000Z');
  });

  it('moves one before the window to its start', () => {
    expect(nextRunAt(stored('2030-01-01T07:00:00Z'))).toBe('2030-01-01T09:00:00.000Z');
  });

  it('keeps one inside the window, and any routine without active hours, as stored', () => {
    expect(nextRunAt(stored('2030-01-01T12:30:00Z'))).toBe('2030-01-01T12:30:00.000Z');
    expect(nextRunAt(stored('2030-01-01T09:00:00Z'))).toBe('2030-01-01T09:00:00.000Z');
    expect(nextRunAt(stored('2030-01-01T18:30:00Z', null))).toBe('2030-01-01T18:30:00.000Z');
  });

  it('reads the window in its own time zone', () => {
    // 6:30 PM in New York, after its 9-to-6 window: 9:00 AM there the next day.
    expect(nextRunAt(stored('2030-01-01T23:30:00Z', { ...NINE_TO_SIX, tz: 'America/New_York' }))).toBe('2030-01-02T14:00:00.000Z');
  });

  it('a paused routine has no next run', () => {
    expect(nextRunAt(stored(null))).toBeNull();
  });

  it('is still a view the contract accepts', () => {
    const view = routineView(stored('2030-01-01T18:30:00Z'), 'owner', true);
    expect(C.RoutineViewSchema.parse(view)).toEqual(view);
  });
});
