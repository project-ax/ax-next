import { describe, expect, it } from 'vitest';
import {
  deriveActivity,
  DEFAULT_PHRASE,
  MAX_PHRASE_CHARS,
  STALE_AFTER_MS,
} from '../derive.js';
import type { DeriveInput } from '../types.js';

const T0 = Date.parse('2026-08-21T09:00:00.000Z');

function input(over: Partial<DeriveInput> = {}): DeriveInput {
  return {
    tool: null,
    trigger: null,
    startedAt: T0,
    lastStepAt: T0,
    now: T0 + 1_000,
    ...over,
  };
}

describe('deriveActivity — the tiers', () => {
  it('T1 beats T0 when a tool phrase is available', () => {
    expect(
      deriveActivity(
        input({ tool: { phrase: 'Reading email' }, trigger: 'Morning email pass' }),
      ),
    ).toMatchObject({ phrase: 'Reading email', source: 'tool' });
  });

  it('falls back to the trigger label — this tier ALWAYS resolves', () => {
    expect(deriveActivity(input({ trigger: 'Morning email pass' }))).toMatchObject({
      phrase: 'Morning email pass',
      source: 'trigger',
    });
  });

  it('falls back again for a user-initiated turn with no routine', () => {
    const a = deriveActivity(input());
    expect(a.phrase).toBe('Working on your request');
    expect(a.phrase).toBe(DEFAULT_PHRASE);
    expect(a.source).toBe('trigger');
  });

  it('treats a blank trigger label as no label rather than rendering an empty line', () => {
    expect(deriveActivity(input({ trigger: '   ' })).phrase).toBe(DEFAULT_PHRASE);
  });

  it('treats a blank tool phrase as no phrase and drops to T0', () => {
    expect(
      deriveActivity(input({ tool: { phrase: '  ' }, trigger: 'Morning email pass' })).phrase,
    ).toBe('Morning email pass');
  });

  it('never reports the parked `declared` tier — T2 does not ship', () => {
    const sources = [
      deriveActivity(input({ tool: { phrase: 'Reading email' } })).source,
      deriveActivity(input({ trigger: 'Morning email pass' })).source,
      deriveActivity(input()).source,
    ];
    expect(sources).not.toContain('declared');
  });

  it('reports startedAt as an ISO instant, independent of the phrase tier', () => {
    expect(deriveActivity(input({ trigger: 'x' })).startedAt).toBe('2026-08-21T09:00:00.000Z');
  });
});

describe('deriveActivity — staleness REPLACES, it does not decorate', () => {
  it('replaces the phrase after 90 seconds of silence', () => {
    const a = deriveActivity(
      input({
        tool: { phrase: 'Reading email', countable: 'messages', reported: { done: 29, total: 41 } },
        lastStepAt: T0,
        now: T0 + 4 * 60_000,
      }),
    );
    expect(a.phrase).toBe('No activity for 4 minutes');
    expect(a.stale).toBe(true);
    expect(a.counter).toBeNull();
  });

  it('does not go stale one second early', () => {
    const a = deriveActivity(
      input({ tool: { phrase: 'Reading email' }, lastStepAt: T0, now: T0 + 89_000 }),
    );
    expect(a.stale).toBe(false);
    expect(a.phrase).toBe('Reading email');
  });

  it('goes stale exactly at the threshold, and says "1 minute" in the singular', () => {
    const a = deriveActivity(
      input({ tool: { phrase: 'Reading email' }, lastStepAt: T0, now: T0 + STALE_AFTER_MS }),
    );
    expect(STALE_AFTER_MS).toBe(90_000);
    expect(a.stale).toBe(true);
    expect(a.phrase).toBe('No activity for 1 minute');
  });

  it('keeps the tier it had resolved to, so a debugger can see what went quiet', () => {
    const a = deriveActivity(
      input({ tool: { phrase: 'Reading email' }, lastStepAt: T0, now: T0 + 10 * 60_000 }),
    );
    expect(a.source).toBe('tool');
    expect(a.phrase).toBe('No activity for 10 minutes');
  });

  it('goes stale on the T0 floor too — a quiet agent is quiet whatever the tier', () => {
    const a = deriveActivity(input({ lastStepAt: T0, now: T0 + 3 * 60_000 }));
    expect(a.phrase).toBe('No activity for 3 minutes');
    expect(a.source).toBe('trigger');
  });

  it('rounds the gap DOWN, so the line never overstates the silence', () => {
    const a = deriveActivity(input({ lastStepAt: T0, now: T0 + 3 * 60_000 + 59_000 }));
    expect(a.phrase).toBe('No activity for 3 minutes');
  });

  it('is not stale when a step just arrived, however long the turn has run', () => {
    const a = deriveActivity(
      input({
        tool: { phrase: 'Reading email' },
        startedAt: T0,
        lastStepAt: T0 + 60 * 60_000,
        now: T0 + 60 * 60_000 + 1_000,
      }),
    );
    expect(a.stale).toBe(false);
    expect(a.startedAt).toBe('2026-08-21T09:00:00.000Z');
  });
});

describe('deriveActivity — what the counter may count', () => {
  it('only counts what the tool reported over a total the tool knew', () => {
    expect(
      deriveActivity(
        input({
          tool: {
            phrase: 'Reading email',
            countable: 'messages',
            reported: { done: 29, total: 41 },
          },
        }),
      ).counter,
    ).toEqual({ done: 29, total: 41, unit: 'messages' });

    expect(
      deriveActivity(input({ tool: { phrase: 'Working through your inbox' } })).counter,
    ).toBeNull();
  });

  it('refuses a report with no unit — an unlabelled "29 of 41" is not a sentence', () => {
    expect(
      deriveActivity(input({ tool: { phrase: 'Reading email', reported: { done: 1, total: 2 } } }))
        .counter,
    ).toBeNull();
  });

  it('refuses a unit with no report — we do not estimate the total', () => {
    expect(
      deriveActivity(input({ tool: { phrase: 'Reading email', countable: 'messages' } })).counter,
    ).toBeNull();
  });

  it('refuses a nonsensical report rather than rendering it', () => {
    const bad = [
      { done: -1, total: 41 },
      { done: 42, total: 41 },
      { done: 1, total: 0 },
      { done: 1.5, total: 41 },
      { done: Number.NaN, total: 41 },
    ];
    for (const reported of bad) {
      expect(
        deriveActivity(input({ tool: { phrase: 'Reading email', countable: 'messages', reported } }))
          .counter,
      ).toBeNull();
    }
  });

  it('there is no counter without a tool at all', () => {
    expect(deriveActivity(input({ trigger: 'Morning email pass' })).counter).toBeNull();
  });
});

describe('deriveActivity — the line is one line', () => {
  // A routine's `name` reaches T0 unbounded: it comes from a file in the
  // agent's own workspace, `validator-routine` only checks it is a non-empty
  // string, and an agent can author a routine — so it is neither length-capped
  // nor reliably a human's words.
  it('flattens a multi-line trigger label into one line', () => {
    expect(
      deriveActivity(input({ trigger: 'Morning\nemail\r\n\tpass' })).phrase,
    ).toBe('Morning email pass');
  });

  it('strips control characters rather than passing them to a renderer', () => {
    const a = deriveActivity(input({ trigger: 'Morning\u0007email\u0000pass' }));
    expect(a.phrase).toBe('Morning email pass');
      expect(a.phrase).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  });

  it.each([
    ['a right-to-left override', '\u202EMorning email pass'],
    ['an unterminated isolate', '\u2066Morning email pass'],
    ['a zero-width space', 'Morning\u200Bemail pass'],
    ['a zero-width joiner', 'Morning\u200Demail pass'],
    ['a byte-order mark', '\uFEFFMorning email pass'],
    ['an Arabic letter mark', '\u061CMorning email pass'],
  ])('neutralises %s — a label must not be able to reorder what a reader sees', (_what, trigger) => {
    const { phrase } = deriveActivity(input({ trigger }));
    expect(phrase).not.toMatch(
      /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/,
    );
    expect(phrase).toBe('Morning email pass');
  });

  it('truncates on code points, never leaving half a surrogate pair behind', () => {
    // 59 plain characters then an astral one, so a UTF-16 slice at 59 would cut
    // the pair in half and emit a lone high surrogate.
    const label = `${'M'.repeat(58)}\u{1F600}\u{1F600}\u{1F600}`;
    const { phrase } = deriveActivity(input({ trigger: label }));
    expect([...phrase]).toHaveLength(MAX_PHRASE_CHARS);
    expect(phrase.endsWith('…')).toBe(true);
    expect(phrase.isWellFormed()).toBe(true);
  });

  it('truncates an over-long label and MARKS that it truncated', () => {
    const a = deriveActivity(input({ trigger: 'M'.repeat(200) }));
    expect(a.phrase).toHaveLength(MAX_PHRASE_CHARS);
    expect(a.phrase.endsWith('…')).toBe(true);
  });

  it('leaves a label that already fits completely alone', () => {
    const exact = 'M'.repeat(MAX_PHRASE_CHARS);
    expect(deriveActivity(input({ trigger: exact })).phrase).toBe(exact);
  });

  it('fences the counter unit too', () => {
    expect(
      deriveActivity(
        input({
          tool: {
            phrase: 'Reading email',
            countable: ' mess\nages ',
            reported: { done: 1, total: 2 },
          },
        }),
      ).counter,
    ).toEqual({ done: 1, total: 2, unit: 'mess ages' });
  });

  it('caps every tier, including a tool phrase that somehow got past the schema', () => {
    const a = deriveActivity(input({ tool: { phrase: 'R'.repeat(500) } }));
    expect(a.phrase.length).toBeLessThanOrEqual(MAX_PHRASE_CHARS);
    expect(a.source).toBe('tool');
  });
});

describe('deriveActivity — the things this surface must never say', () => {
  // A routine's name is authored in a file in the agent's own workspace and
  // reviewed by nobody. A reader cannot tell whose voice the line is in, so a
  // label carrying progress-bar vocabulary is declined, not rewritten.
  it.each([
    'Inbox — 40 left',
    'Sync 80% of the archive',
    'Time remaining check',
    'Delivery ETA sweep',
  ])('declines a trigger label that talks like a progress bar: %s', (trigger) => {
    const a = deriveActivity(input({ trigger }));
    expect(a.phrase).toBe(DEFAULT_PHRASE);
    expect(a.source).toBe('trigger');
  });

  it('declines a tool phrase that talks like a progress bar, dropping to T0', () => {
    const a = deriveActivity(
      input({ tool: { phrase: 'Reading 80% of email' }, trigger: 'Morning email pass' }),
    );
    expect(a.phrase).toBe('Morning email pass');
    expect(a.source).toBe('trigger');
  });

  it('does not fire on an innocent word that merely contains one', () => {
    for (const trigger of ['Beta channel sweep', 'Leftover receipts', 'Metadata pass']) {
      expect(deriveActivity(input({ trigger })).phrase).toBe(trigger);
    }
  });

  it('declines a counter unit that talks like a progress bar', () => {
    expect(
      deriveActivity(
        input({
          tool: { phrase: 'Reading email', countable: '% done', reported: { done: 1, total: 2 } },
        }),
      ).counter,
    ).toBeNull();
  });


  it('never emits a percentage, a remaining, an eta, or a time left', () => {
    const matrix: DeriveInput[] = [
      input(),
      input({ trigger: 'Morning email pass' }),
      input({ tool: { phrase: 'Reading email' } }),
      // Inputs that WOULD say it, so this test guards the guard rather than
      // only re-checking our own hardcoded strings.
      input({ trigger: 'Inbox — 40 left' }),
      input({ tool: { phrase: '80% through the inbox' }, trigger: 'ETA sweep' }),
      input({
        tool: { phrase: 'Reading email', countable: '% done', reported: { done: 1, total: 2 } },
      }),
      input({
        tool: { phrase: 'Reading email', countable: 'messages', reported: { done: 29, total: 41 } },
      }),
      input({ tool: { phrase: 'Reading email' }, lastStepAt: T0, now: T0 + 40 * 60_000 }),
      input({ trigger: 'Morning email pass', lastStepAt: T0, now: T0 + 90_000 }),
    ];
    for (const one of matrix) {
      const rendered = JSON.stringify(deriveActivity(one));
      expect(rendered).not.toMatch(/%|remaining|left|eta/i);
    }
  });
});

describe('deriveActivity — it does not take its caller down', () => {
  it('survives a non-finite startedAt rather than throwing on toISOString', () => {
    for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 * 2]) {
      const a = deriveActivity(input({ startedAt, trigger: 'Morning email pass' }));
      expect(() => new Date(a.startedAt).toISOString()).not.toThrow();
      expect(a.phrase).toBe('Morning email pass');
    }
  });

  it('falls back to `now` before it falls back to the epoch', () => {
    expect(deriveActivity(input({ startedAt: Number.NaN, now: T0 })).startedAt).toBe(
      '2026-08-21T09:00:00.000Z',
    );
  });
});

describe('deriveActivity — purity', () => {
  it('is a pure function of its input, with time injected', () => {
    const one = input({
      tool: { phrase: 'Reading email', countable: 'messages', reported: { done: 3, total: 9 } },
      trigger: 'Morning email pass',
    });
    expect(deriveActivity(one)).toEqual(deriveActivity(one));
  });

  it('changes ONLY because `now` moved, never because wall-clock time passed', () => {
    const base = input({ tool: { phrase: 'Reading email' }, lastStepAt: T0 });
    const before = deriveActivity({ ...base, now: T0 + 1_000 });
    const after = deriveActivity({ ...base, now: T0 + 1_000 });
    expect(after).toEqual(before);
    expect(deriveActivity({ ...base, now: T0 + 120_000 }).stale).toBe(true);
  });

  it('does not mutate the input it was handed', () => {
    const one = input({
      tool: { phrase: 'Reading email', countable: 'messages', reported: { done: 3, total: 9 } },
    });
    const snapshot = structuredClone(one);
    deriveActivity(one);
    expect(one).toEqual(snapshot);
  });
});
