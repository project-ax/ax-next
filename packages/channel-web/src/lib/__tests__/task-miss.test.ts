import { describe, expect, it } from 'vitest';
import { CHECK_IN_MISSES, type CheckInMiss } from '@ax/routines-contract';
import { AUTO_PAUSED_LINE, missSummary, missWords } from '../task-miss.js';

const TRY_AGAIN = 'Press Check now to try again.';
const RESUME = 'Press Resume, and it’ll try again at its next check-in.';
const ASK = 'If it keeps happening, tell whoever runs your workspace.';
const NEXT_CHECK_IN = 'It’ll try again at its next check-in.';
const NOT_YOURS_TO_RESUME = 'Only someone who manages this agent’s tasks can resume it.';
const ALL = { checkNow: true, edit: true };

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
    'Shorten “What should Quill do?” in Edit.',
    'Shorten “What should Quill do?” in Edit, then resume it.',
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
    expect(missWords(code, 'Quill', false, ALL)).toEqual({ what, fix, settingsLink });
  });

  it.each(CHECK_IN_MISSES)('%s: exact words while paused', (code) => {
    const [what, , fix, settingsLink] = TABLE[code];
    expect(missWords(code, 'Quill', true, ALL)).toEqual({ what, fix, settingsLink });
  });

  /** The words with `Press Check now to try again.` swapped for what a viewer who can't press it reads. */
  const withoutCheckNow = (fix: string) => fix.replace(TRY_AGAIN, NEXT_CHECK_IN);
  const withoutResume = (fix: string) => fix.replace(RESUME, NOT_YOURS_TO_RESUME);

  it.each(CHECK_IN_MISSES)('%s: without Check now, never tells the viewer to press it', (code) => {
    const [what, fix, , settingsLink] = TABLE[code];
    const words = missWords(code, 'Quill', false, { checkNow: false, edit: true });
    expect(words).toEqual({ what, fix: withoutCheckNow(fix), settingsLink });
    expect(words.fix).not.toMatch(/Check now/);
  });

  it.each(CHECK_IN_MISSES.filter((c) => c !== 'brief-too-long'))(
    '%s: without edit, never tells the viewer to press Resume',
    (code) => {
      const [what, , fix, settingsLink] = TABLE[code];
      const words = missWords(code, 'Quill', true, { checkNow: true, edit: false });
      expect(words).toEqual({ what, fix: withoutResume(fix), settingsLink });
      expect(words.fix).not.toMatch(/Press Resume/);
    },
  );

  it('a too-long brief, for a viewer who can’t edit, says who needs to shorten it and offers no link or button to press', () => {
    const running = missWords('brief-too-long', 'Quill', false, { checkNow: true, edit: false });
    expect(running).toEqual({
      what: 'Its instructions are too long to load.',
      fix: 'Someone who manages this agent’s tasks needs to shorten “What should Quill do?” in Edit.',
      settingsLink: false,
    });
    const paused = missWords('brief-too-long', 'Quill', true, { checkNow: true, edit: false });
    expect(paused).toEqual({
      what: 'Its instructions are too long to load.',
      fix: 'Someone who manages this agent’s tasks needs to shorten “What should Quill do?” in Edit. Then they can resume it.',
      settingsLink: false,
    });
    for (const w of [running, paused]) {
      expect(w.fix).not.toMatch(/Press|^Shorten|, then resume it/);
    }
  });

  it('a viewer who can only resume still reads Resume while paused, and one who can only check reads Check now while running', () => {
    expect(missWords('failed', 'Quill', true, { checkNow: false, edit: true }).fix).toBe(RESUME);
    expect(missWords('failed', 'Quill', false, { checkNow: true, edit: false }).fix).toBe(TRY_AGAIN);
  });

  it('points at settings only for a brief that is too long', () => {
    expect(CHECK_IN_MISSES.filter((c) => missWords(c, 'Quill', false, ALL).settingsLink)).toEqual([
      'brief-too-long',
    ]);
  });

  it('never names a link in the fix; those are their own elements', () => {
    for (const c of CHECK_IN_MISSES) {
      for (const p of [false, true]) {
        expect(missWords(c, 'Quill', p, ALL).fix).not.toMatch(/See what it did/);
      }
    }
  });

  it('uses typographic marks, never straight ones', () => {
    for (const c of CHECK_IN_MISSES) {
      for (const p of [false, true]) {
        const { what, fix } = missWords(c, 'Quill', p, ALL);
        expect(`${what}${fix}`).not.toMatch(/['"]/);
      }
    }
  });

  it('treats an unknown code as failed', () => {
    expect(missWords('from-a-newer-host' as CheckInMiss, 'Quill', false, ALL)).toEqual(
      missWords('failed', 'Quill', false, ALL),
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
