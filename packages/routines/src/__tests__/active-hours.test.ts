import { describe, expect, it } from 'vitest';
import { advanceToNextActiveWindow } from '../active-hours.js';

describe('advanceToNextActiveWindow', () => {
  const ah = { start: '08:00', end: '24:00', tz: 'America/New_York' };

  it('returns the candidate when it falls inside the window', () => {
    // 2026-05-14 14:00 NYC = 18:00Z (EDT).
    const candidate = new Date('2026-05-14T18:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    expect(adjusted.toISOString()).toBe(candidate.toISOString());
  });

  it('shifts a candidate before the start to the day start', () => {
    // 2026-05-14 03:00 NYC = 07:00Z. Before 08:00 start.
    const candidate = new Date('2026-05-14T07:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    // 2026-05-14 08:00 NYC = 12:00Z.
    expect(adjusted.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });

  it('shifts a candidate after the end to the next day start', () => {
    // end = 24:00 means "midnight" — so 24:00 NYC = 04:00Z (next day).
    // Candidate 2026-05-15 05:00Z (= 2026-05-15 01:00 NYC, past midnight) →
    // shift to 2026-05-15 08:00 NYC = 12:00Z.
    const candidate = new Date('2026-05-15T05:00:00Z');
    const adjusted = advanceToNextActiveWindow(candidate, ah);
    expect(adjusted.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });
});
