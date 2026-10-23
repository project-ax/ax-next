import { describe, expect, it } from 'vitest';
import { CHECK_IN_MISSES, type CheckInMiss } from '@ax/routines-contract';
import { AUTO_PAUSED_LINE, missSummary, missWords } from '../task-miss.js';

const TRY_AGAIN = 'Press Check now to try again.';
const RESUME = 'Press Resume, and it’ll try again at its next check-in.';
const ASK = 'If it keeps happening, tell whoever runs your workspace.';

/** [what, fix while running, fix while paused, settingsLink]; typographic marks written as escapes. */
const TABLE: Record<CheckInMiss, [string, string, string, boolean]> = {
  'no-report': ['It checked in but didn’t say how it went.', TRY_AGAIN, RESUME, false],
  'brief-missing': [
    'Its instructions didn’t load, so it couldn’t check in.',
    `${TRY_AGAIN} ${ASK}`,
    `${RESUME} ${ASK}`,
    false,
  ],
  'brief-unconfirmed': [
    'We couldn’t confirm its instructions loaded, so we counted that check-in as missed.',
    `${TRY_AGAIN} ${ASK}`,
    `${RESUME} ${ASK}`,
    false,
  ],
  'brief-too-long': [
    'Its instructions are too long to load.',
    'Shorten “What to do” in Quill’s settings.',
    'Shorten “What to do” in Quill’s settings, then resume it.',
    true,
  ],
  interrupted: [
    'The app restarted during its check-in.',
    'Nothing to do. It’ll try again at its next check-in.',
    RESUME,
    false,
  ],
  failed: ['Its check-in stopped before it finished.', TRY_AGAIN, RESUME, false],
};

describe('missWords', () => {
  it('covers every reason code', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...CHECK_IN_MISSES].sort());
  });

  it.each(CHECK_IN_MISSES)('%s: exact words while running', (code) => {
    const [what, fix, , settingsLink] = TABLE[code];
    expect(missWords(code, 'Quill', false)).toEqual({ what, fix, settingsLink });
  });

  it.each(CHECK_IN_MISSES)('%s: exact words while paused', (code) => {
    const [what, , fix, settingsLink] = TABLE[code];
    expect(missWords(code, 'Quill', true)).toEqual({ what, fix, settingsLink });
  });

  it('points at settings only for a brief that is too long', () => {
    expect(CHECK_IN_MISSES.filter((c) => missWords(c, 'Quill', false).settingsLink)).toEqual([
      'brief-too-long',
    ]);
  });

  it('never names a link in the fix; those are their own elements', () => {
    for (const c of CHECK_IN_MISSES) {
      for (const p of [false, true]) {
        expect(missWords(c, 'Quill', p).fix).not.toMatch(/See what it did/);
      }
    }
  });

  it('uses typographic marks, never straight ones', () => {
    for (const c of CHECK_IN_MISSES) {
      for (const p of [false, true]) {
        const { what, fix } = missWords(c, 'Quill', p);
        expect(`${what}${fix}`).not.toMatch(/['"]/);
      }
    }
  });

  it('treats an unknown code as failed', () => {
    expect(missWords('from-a-newer-host' as CheckInMiss, 'Quill', false)).toEqual(
      missWords('failed', 'Quill', false),
    );
  });
});

describe('missSummary', () => {
  it('says only what happened below three in a row', () => {
    expect(missSummary({ inARow: 1, reason: 'no-report' })).toBe(TABLE['no-report'][0]);
    expect(missSummary({ inARow: 2, reason: 'failed' })).toBe(TABLE.failed[0]);
  });

  it.each([3, 7])('leads with the count at %i in a row', (n) => {
    expect(missSummary({ inARow: n, reason: 'no-report' })).toBe(
      `Its last ${n} check-ins didn’t leave an update. It checked in but didn’t say how it went.`,
    );
  });
});

describe('AUTO_PAUSED_LINE', () => {
  it('names the auto-pause threshold', () => {
    expect(AUTO_PAUSED_LINE).toBe('Paused after 5 check-ins in a row didn’t leave an update.');
  });
});
