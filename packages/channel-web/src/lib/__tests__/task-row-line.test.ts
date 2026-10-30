import { describe, expect, it } from 'vitest';
import { AUTO_PAUSED_LINE } from '../task-miss.js';
import { CLAIM_LINE, repeatLine, rowFact, rowLatest, shortAgo } from '../task-row-line.js';
import type { RepeatTaskState, TaskRow, TaskRowReport } from '../workspace-types.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function report(over: Partial<TaskRowReport> = {}): TaskRowReport {
  return {
    status: 'on-track',
    update: 'All quiet.',
    ask: null,
    reading: null,
    doneClaimed: false,
    reportedAt: minsAgo(4),
    ...over,
  };
}

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    agentId: 'a1',
    agentName: 'Caveman',
    routineId: 'r1',
    name: 'Inbox',
    enabled: true,
    kind: 'stay-on-top',
    steps: null,
    finishBy: null,
    task: null,
    noRecentUpdate: null,
    doneAt: null,
    canMarkDone: true,
    ...over,
  };
}

const RUN: RepeatTaskState = {
  lastRunAt: null,
  status: null,
  error: null,
  warning: null,
  active: 0,
  waiting: 0,
  sharedThread: false,
  appUpdates: false,
};

const miss = (over: Partial<NonNullable<TaskRow['noRecentUpdate']>> = {}) => ({
  inARow: 1,
  reason: 'no-report' as const,
  at: minsAgo(1),
  autoPaused: false,
  ...over,
});

describe('shortAgo', () => {
  it.each([
    [0, 'now'],
    [4, '4m'],
    [59, '59m'],
    [60, '1h'],
    [23 * 60 + 59, '23h'],
    [24 * 60, '1d'],
    [-5, 'now'],
  ])('%i minutes ago reads %s', (mins, text) => {
    expect(shortAgo(minsAgo(mins), NOW)).toBe(text);
  });

  it('is null on an instant it cannot read', () => {
    expect(shortAgo('not a time', NOW)).toBeNull();
  });
});

describe('rowLatest', () => {
  it('a current claim without misses is the line, over the update', () => {
    expect(rowLatest(row({ task: report({ status: 'needs-you', doneClaimed: true }) }))).toEqual({
      text: CLAIM_LINE,
      agentText: false,
      ask: false,
    });
  });

  it('misses win over an old claim and the update', () => {
    const latest = rowLatest(row({ task: report({ doneClaimed: true }), noRecentUpdate: miss() }));
    expect(latest?.text).toBe('It checked in but didn’t say how it went.');
  });

  it('an auto-paused task says why it is paused', () => {
    const latest = rowLatest(row({ enabled: false, task: report(), noRecentUpdate: miss({ inARow: 5, autoPaused: true }) }));
    expect(latest?.text).toBe(AUTO_PAUSED_LINE);
  });

  it('a needs-you row quotes its ask; any other row shows its update', () => {
    expect(rowLatest(row({ task: report({ status: 'needs-you', ask: 'Pause it?' }) }))).toEqual({
      text: 'Pause it?',
      agentText: true,
      ask: true,
    });
    expect(rowLatest(row({ enabled: false, task: report({ status: 'needs-you', ask: 'Pause it?' }) }))?.text).toBe(
      'All quiet.',
    );
    expect(rowLatest(row({ task: report({ status: 'needs-you' }) }))?.ask).toBe(false);
  });

  it('a done row shows its last update whatever came before', () => {
    const done = row({ doneAt: minsAgo(60), task: report({ doneClaimed: true }), noRecentUpdate: miss() });
    expect(rowLatest(done)?.text).toBe('All quiet.');
  });

  it('is null with nothing to say', () => {
    expect(rowLatest(row())).toBeNull();
    expect(rowLatest(row({ task: report({ update: null }) }))).toBeNull();
  });
});

describe('repeatLine', () => {
  it('words the last run, then counts, on one line', () => {
    expect(repeatLine(undefined, true)).toBe('Run details are unavailable.');
    expect(repeatLine(RUN, true)).toBe('No completed runs yet.');
    expect(repeatLine({ ...RUN, status: 'ok' }, true)).toBe('Last run completed.');
    expect(repeatLine({ ...RUN, status: 'silenced', warning: 'Nothing to send.' }, true)).toBe(
      'Last run finished quietly. Nothing to send.',
    );
    expect(repeatLine({ ...RUN, status: 'error', error: 'Delivery failed.', waiting: 1 }, true)).toBe(
      'Last run failed. Delivery failed. · 1 app update waiting',
    );
    // The routines store's own sentences, byte for byte, read plainly (`runFailureText`).
    expect(
      repeatLine({ ...RUN, status: 'error', error: 'The routine run was interrupted by a host restart.' }, true),
    ).toBe('Last run failed. Stopped early because we restarted. It runs again next time.');
    expect(
      repeatLine({ ...RUN, status: 'error', error: 'The routine run closed before it could start.' }, true),
    ).toBe('Last run failed. Something went wrong, so this run didn’t finish.');
    expect(repeatLine({ ...RUN, active: 2 }, true)).toBe('Working. · 2 runs active');
    expect(repeatLine({ ...RUN, active: 1 }, false)).toBe('Finishing after Pause.');
  });
});

describe('rowFact', () => {
  it('says when it last checked: the miss first, else the report, else nothing', () => {
    expect(rowFact(row({ task: report() }), NOW)).toEqual({ short: '4m', full: 'Checked 4 min ago', late: false });
    expect(rowFact(row({ task: report(), noRecentUpdate: miss() }), NOW)?.full).toBe('Checked 1 min ago');
    expect(rowFact(row(), NOW)).toBeNull();
  });

  it('a get-done task counts steps, then its finish date', () => {
    const steps = { done: 3, total: 4 };
    expect(rowFact(row({ kind: 'get-done', steps, task: report() }), NOW)).toEqual({
      short: '3/4',
      full: '3 of 4 steps',
      late: false,
    });
    const fact = rowFact(row({ kind: 'get-done', steps, finishBy: { date: '2026-11-03', daysLeft: 12 } }), NOW);
    expect(fact?.full).toBe('3 of 4 steps · 12 days left');
    expect(fact?.short).toMatch(/^3\/4 · /);
    expect(rowFact(row({ kind: 'get-done', steps, finishBy: { date: '2026-10-19', daysLeft: -3 } }), NOW)?.late).toBe(true);
    // No steps yet: the check-in time stands in, and the date follows.
    expect(
      rowFact(row({ kind: 'get-done', steps: { done: 0, total: 0 }, finishBy: { date: '2026-11-03', daysLeft: 12 } }), NOW)
        ?.full,
    ).toBe('12 days left');
  });

  it('a finish date on another kind says nothing', () => {
    expect(rowFact(row({ finishBy: { date: '2026-11-03', daysLeft: 12 } }), NOW)).toBeNull();
  });

  it('a done task says when it was done, or just "Done"', () => {
    expect(rowFact(row({ doneAt: minsAgo(60) }), NOW)?.full).toMatch(/^Done (at |yesterday at |on )/);
    expect(rowFact(row({ doneAt: 'not a time' }), NOW)).toEqual({ short: 'Done', full: 'Done', late: false });
  });

  it('a Repeat job says its last run, or nothing before one', () => {
    // Local noon, so the run is on the same local day in any time zone.
    const noon = new Date(2026, 9, 22, 12, 0);
    const halfHourAgo = new Date(noon.getTime() - 30 * 60_000).toISOString();
    expect(rowFact(row({ kind: 'repeat', repeat: { ...RUN, lastRunAt: halfHourAgo } }), noon)).toEqual({
      short: 'Today',
      full: 'Last run 30 min ago',
      late: false,
    });
    expect(rowFact(row({ kind: 'repeat', repeat: RUN }), NOW)).toBeNull();
  });
});
