/**
 * TASK-345 / audit E5 — say what a cron expression means.
 *
 * The routine editor asks for `0 2 * * *` and an IANA timezone string. Both are
 * exact, and both are opaque: a person who is not sure whether they just asked
 * for 2am or 2pm has no way to find out from the form, and will discover the
 * answer when the routine runs.
 */
import { describe, expect, it } from 'vitest';
import { describeCron } from '../cron-describe';

describe('describeCron — the common shapes', () => {
  it('describes a daily run at a time', () => {
    expect(describeCron('0 2 * * *')).toEqual({
      kind: 'described',
      text: 'Runs at 2:00 AM, every day',
    });
  });

  it('gets afternoon and midnight right, which is the whole point', () => {
    expect(describeCron('30 14 * * *')).toEqual({
      kind: 'described',
      text: 'Runs at 2:30 PM, every day',
    });
    expect(describeCron('0 0 * * *')).toEqual({
      kind: 'described',
      text: 'Runs at 12:00 AM, every day',
    });
    expect(describeCron('0 12 * * *')).toEqual({
      kind: 'described',
      text: 'Runs at 12:00 PM, every day',
    });
  });

  it('names a single weekday', () => {
    expect(describeCron('0 9 * * 1')).toEqual({
      kind: 'described',
      text: 'Runs at 9:00 AM, every Monday',
    });
    // Both spellings of Sunday.
    expect(describeCron('0 9 * * 0')).toEqual({
      kind: 'described',
      text: 'Runs at 9:00 AM, every Sunday',
    });
    expect(describeCron('0 9 * * 7')).toEqual({
      kind: 'described',
      text: 'Runs at 9:00 AM, every Sunday',
    });
  });

  it('recognises weekdays as a phrase rather than a list', () => {
    expect(describeCron('0 9 * * 1-5')).toEqual({
      kind: 'described',
      text: 'Runs at 9:00 AM, every weekday',
    });
  });

  it('describes minute and hour intervals', () => {
    expect(describeCron('*/15 * * * *')).toEqual({
      kind: 'described',
      text: 'Runs every 15 minutes',
    });
    expect(describeCron('0 */6 * * *')).toEqual({
      kind: 'described',
      text: 'Runs every 6 hours',
    });
    expect(describeCron('* * * * *')).toEqual({
      kind: 'described',
      text: 'Runs every minute',
    });
  });

  it('describes a monthly run', () => {
    expect(describeCron('0 3 1 * *')).toEqual({
      kind: 'described',
      text: 'Runs at 3:00 AM on the 1st of each month',
    });
    expect(describeCron('0 3 22 * *')).toEqual({
      kind: 'described',
      text: 'Runs at 3:00 AM on the 22nd of each month',
    });
  });

  it('names the timezone when one is given', () => {
    expect(describeCron('0 2 * * *', 'America/New_York')).toEqual({
      kind: 'described',
      text: 'Runs at 2:00 AM, every day (America/New_York)',
    });
  });
});

describe('describeCron — the honest edges', () => {
  it('says nothing rather than guessing at an expression it cannot read', () => {
    // A wrong description is worse than no description: it would tell someone
    // their routine runs at a time it does not.
    expect(describeCron('0 2 * 3 1#2')).toEqual({ kind: 'unknown' });
    expect(describeCron('15,45 2-4 * * *')).toEqual({ kind: 'unknown' });
  });

  it('reports an invalid expression instead of throwing', () => {
    for (const bad of ['', 'nonsense', '0 2 * *', '0 2 * * * *', '99 2 * * *', '0 99 * * *']) {
      expect(describeCron(bad)).toEqual({ kind: 'invalid' });
    }
  });

  it('tolerates ragged whitespace', () => {
    expect(describeCron('  0   2  *  *  * ')).toEqual({
      kind: 'described',
      text: 'Runs at 2:00 AM, every day',
    });
  });
});
