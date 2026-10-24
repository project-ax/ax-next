/**
 * A task's reading for a person (TASK-952): its number in their own locale,
 * the readings that share its label, oldest first, and the sparkline's points.
 * Formatting passes 'en-US', so nothing depends on where the suite runs.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  formatReading,
  READING_TREND_MAX,
  readingTrend,
  sparklinePoints,
} from '../task-reading.js';
import type { TaskDetailReport, TaskReading, TaskUpdate } from '../workspace-types.js';

type Latest = Pick<TaskDetailReport, 'status' | 'update' | 'reading'>;

const open = (value: number): TaskReading => ({ label: 'Open tickets', value });

/** The task's latest report: on track, "Answered two.", unless told otherwise. */
function latest(reading: TaskReading | null, update = 'Answered two.'): Latest {
  return { status: 'on-track', update, reading };
}

/** A finished check-in whose report said `update` and sent `reading`. */
function checkIn(update: string, reading: TaskReading | null): TaskUpdate {
  return {
    firedAt: '2026-10-24T10:00:00.000Z',
    status: 'ok',
    error: null,
    report: { status: 'on-track', update, reading },
    conversationId: null,
  };
}

/** A check-in that left no report at all. */
function silent(over: Partial<TaskUpdate> = {}): TaskUpdate {
  return { ...checkIn('', null), report: null, ...over };
}

describe('formatReading', () => {
  it('shows up to two decimals, grouped as the reader’s locale groups them', () => {
    expect([3, 2.5, 1234.567, 1e12].map((v) => formatReading(v, 'en-US'))).toEqual([
      '3',
      '2.5',
      '1,234.57',
      '1,000,000,000,000',
    ]);
  });

  it('never shows "-0", and keeps the sign of a real negative', () => {
    expect(formatReading(-0, 'en-US')).toBe('0');
    expect(formatReading(0, 'en-US')).toBe('0');
    expect(formatReading(-2.5, 'en-US')).toBe('-2.5');
  });

  // Browsers older than Chrome 106 / Safari 15.4 / Firefox 116 refuse
  // signDisplay 'negative' with a RangeError, which would break the page's render.
  it('formats without signDisplay, so an older browser doesn’t throw', () => {
    const Real = Intl.NumberFormat;
    const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (
      locales?: string | string[],
      options?: Intl.NumberFormatOptions,
    ) {
      if (options?.signDisplay === 'negative') throw new RangeError('signDisplay');
      return new Real(locales, options);
    } as typeof Intl.NumberFormat);
    try {
      expect(formatReading(-0, 'en-US')).toBe('0');
      expect(formatReading(-2.5, 'en-US')).toBe('-2.5');
      expect(formatReading(0.0031, 'en-US')).toBe('0.0031');
    } finally {
      spy.mockRestore();
    }
  });

  // A small reading keeps its digits: rounding 0.0031 to "0" would show a flat
  // "Earlier: 0 · 0" beside a sparkline that swings, and lose the agent's number.
  it('keeps three significant digits below one, and goes scientific when tiny', () => {
    expect([0.0031, -0.004, 0.123456, 0.0001, 1e-300, -1e-5].map((v) => formatReading(v, 'en-US'))).toEqual([
      '0.0031',
      '-0.004',
      '0.123',
      '0.0001',
      '1E-300',
      '-1E-5',
    ]);
  });
});

describe('readingTrend', () => {
  it('keeps only the readings under the latest one’s label', () => {
    const updates = [
      checkIn('Answered two.', open(3)),
      checkIn('Closed a few.', { label: 'Closed today', value: 40 }),
      checkIn('Answered one.', open(5)),
      // Another spelling is another label, so another number.
      checkIn('Quiet.', { label: 'open tickets', value: 7 }),
    ];
    expect(readingTrend(latest(open(3)), updates)).toEqual([5, 3]);
  });

  it(`draws at most the newest ${READING_TREND_MAX}, oldest first`, () => {
    expect(READING_TREND_MAX).toBe(12);
    // Twenty matching check-ins, newest first: 20, 19, … 1. The newest is the latest's own.
    const updates = Array.from({ length: 20 }, (_, i) =>
      checkIn(i === 0 ? 'Answered two.' : `Update ${i}`, open(20 - i)),
    );
    expect(readingTrend(latest(open(20)), updates)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    // While the latest's check-in still runs, it takes one of the twelve.
    expect(readingTrend(latest(open(99), 'Still running.'), updates)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 99,
    ]);
  });

  it('counts the latest once, as the last point, when its own check-in is in Updates', () => {
    const updates = [
      checkIn('Answered two.', open(3)),
      checkIn('Answered one.', open(5)),
      checkIn('Busy start.', open(9)),
    ];
    expect(readingTrend(latest(open(3)), updates)).toEqual([9, 5, 3]);
  });

  it('adds the latest after the earlier ones while its check-in is still running', () => {
    // The newest finished check-in said something else: the latest report's
    // own check-in has no fire row until it finishes (decisions row 10).
    expect(
      readingTrend(latest(open(3)), [checkIn('Answered one.', open(5)), checkIn('Busy start.', open(9))]),
    ).toEqual([9, 5, 3]);
    // The same words with another number is another check-in too.
    expect(readingTrend(latest(open(3)), [checkIn('Answered two.', open(5))])).toEqual([5, 3]);
    // And so is the same report with no reading.
    expect(readingTrend(latest(open(3)), [checkIn('Answered two.', null)])).toEqual([3]);
    // Before its first check-in has finished, the latest stands alone.
    expect(readingTrend(latest(open(3)), [])).toEqual([3]);
  });

  it('is empty when the latest report has no reading', () => {
    const updates = [checkIn('Answered two.', open(3))];
    expect(readingTrend(null, updates)).toEqual([]);
    expect(readingTrend(latest(null), updates)).toEqual([]);
  });

  it('skips check-ins that left no report, and reports that sent no reading', () => {
    const updates = [
      silent(),
      checkIn('Answered two.', open(3)),
      checkIn('Nothing to count.', null),
      silent({ status: 'error', error: 'It ran out of time.' }),
      checkIn('Answered one.', open(5)),
    ];
    expect(readingTrend(latest(open(3)), updates)).toEqual([5, 3]);
  });
});

describe('sparklinePoints', () => {
  it('runs from the lowest at the bottom to the highest at the top, inset by the pad', () => {
    expect(sparklinePoints([1, 2], 96, 24, 2)).toBe('2,22 94,2');
    expect(sparklinePoints([2, 1], 96, 24, 2)).toBe('2,2 94,22');
  });

  it('draws a flat series level through the middle', () => {
    expect(sparklinePoints([5, 5, 5], 96, 24, 2)).toBe('2,12 48,12 94,12');
  });

  it('rounds each coordinate to two decimals', () => {
    expect(sparklinePoints([0, 1, 3], 96, 24, 2)).toBe('2,22 48,15.33 94,2');
  });

  it('keeps every point inside the inset box, whatever the numbers', () => {
    for (const values of [
      [12, 9, 5, 3],
      [-2.5, 1e12, 0, -1e12, 0.004],
      // Finite, but their span isn't: stored rows aren't re-checked (TASK-913).
      [-Number.MAX_VALUE, Number.MAX_VALUE, 0],
    ]) {
      const points = sparklinePoints(values, 96, 24, 2)
        .split(' ')
        .map((p) => p.split(',').map(Number));
      expect(points).toHaveLength(values.length);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(2);
        expect(x).toBeLessThanOrEqual(94);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(y).toBeLessThanOrEqual(22);
      }
    }
  });

  it('draws nothing for fewer than two values', () => {
    expect(sparklinePoints([3], 96, 24, 2)).toBe('');
    expect(sparklinePoints([], 96, 24, 2)).toBe('');
  });
});
