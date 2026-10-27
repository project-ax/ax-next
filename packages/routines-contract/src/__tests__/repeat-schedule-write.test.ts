import { describe, expect, it, vi } from 'vitest';
import * as contract from '../index.js';

type Schedule = { kind: 'interval'; every: string } | { kind: 'cron'; expr: string; tz: string } | null;
const issue = (schedule: Schedule, previous?: Schedule): string | null => {
  const helper = Reflect.get(contract, 'repeatScheduleWriteIssue');
  expect(helper).toBeTypeOf('function');
  return (helper as (schedule: Schedule, previous?: Schedule) => string | null)(schedule, previous);
};
const cron = (expr: string, tz = 'UTC'): Schedule => ({ kind: 'cron', expr, tz });

describe('repeat schedule authoring floor', () => {
  it.each(['* * * * * *', '*/10 * * * * *', '0,59 * * * * *', '0,30 0 8 * * *', '0,59 0,59 0,23 1,15 * *'])('refuses a newly authored subminute schedule %s', expr => {
    expect(issue(cron(expr))).toMatch(/60 seconds/);
  });

  it.each(['* * * * *', '0 * * * * *', '59 * * * * *', '0 */15 * * * *', '0 8 * * 1-5', '@hourly'])('accepts minute-or-longer cadence %s', expr => {
    expect(issue(cron(expr))).toBeNull();
  });

  it('preserves an identical legacy fast cron across unrelated edits or a copied object', () => {
    const previous = cron('*/10 * * * * *');
    expect(issue(cron('*/10 * * * * *'), previous)).toBeNull();
  });

  it('rechecks actual expression or timezone changes to a legacy schedule', () => {
    expect(issue(cron('*/20 * * * * *'), cron('*/10 * * * * *'))).toMatch(/60 seconds/);
    expect(issue(cron('*/10 * * * * *', 'America/New_York'), cron('*/10 * * * * *'))).toMatch(/60 seconds/);
    expect(issue(cron('0 * * * * *'), cron('*/10 * * * * *'))).toBeNull();
  });

  it('allows schedule removal and the existing interval floor', () => {
    expect(issue(null, cron('*/10 * * * * *'))).toBeNull();
    expect(issue({ kind: 'interval', every: '60s' })).toBeNull();
    expect(issue({ kind: 'interval', every: '1m' })).toBeNull();
  });

  it('does not introduce task-only recurrence rules for repeat jobs', () => {
    expect(issue(cron('2031-11-01T09:00:00'))).toBeNull();
    expect(issue(cron('0 0 31 2 *'))).toBeNull();
    expect(issue(cron('? 9 * * *'))).toBeNull();
    expect(issue(cron('? * * * * *'))).toBeNull();
  });

  it('checks clock-relative seconds lists deterministically instead of trusting one parse-time coincidence', () => {
    const verdicts: unknown[] = [];
    for (const time of ['2031-01-01T00:00:00Z', '2031-01-01T00:00:59Z']) {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(time));
        verdicts.push(issue(cron('?,0 * * * * *')));
      } finally { vi.useRealTimers(); }
    }
    expect(verdicts[0]).toMatch(/60 seconds/);
    expect(verdicts[1]).toBe(verdicts[0]);
  });
});
