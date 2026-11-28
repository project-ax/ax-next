import { describe, expect, it } from 'vitest';
import { momentWords } from '../moment-words';

// Local noon on Thu Nov 26 2026, so day buckets are the same in any machine zone.
const NOW = new Date(2026, 10, 26, 12, 0);
const at = (...a: [number, number, number, number, number]) => new Date(...a).toISOString();

describe('momentWords (a moment inside a sentence)', () => {
  it.each([
    [at(2026, 10, 26, 11, 55), '5 min ago'],
    [at(2026, 10, 26, 10, 2), '1 hr ago'],
    [at(2026, 10, 26, 12, 20), 'in 20 min'],
    [at(2026, 10, 26, 15, 0), 'Today 3:00 PM'],
    [at(2026, 10, 27, 9, 0), 'Tomorrow 9:00 AM'],
    [at(2026, 10, 25, 16, 58), 'Yesterday 4:58 PM'],
    [at(2026, 10, 23, 10, 2), 'Mon 10:02 AM'],
  ] as [string, string][])('%s reads %s', (iso, words) => {
    expect(momentWords(iso, NOW)).toBe(words);
  });

  it('keeps the time of day once the relative form would be a bare date', () => {
    // Eight days back and exactly a week ahead: "Nov 18" / "Dec 3" would drop the 10:02 / 9:00.
    expect(momentWords(at(2026, 10, 18, 10, 2), NOW)).toBe('Wed, Nov 18, 2026, 10:02 AM');
    expect(momentWords(at(2026, 11, 3, 9, 0), NOW)).toBe('Thu, Dec 3, 2026, 9:00 AM');
  });

  it('is null for a value that is not a time', () => {
    expect(momentWords('not a time', NOW)).toBeNull();
  });
});
