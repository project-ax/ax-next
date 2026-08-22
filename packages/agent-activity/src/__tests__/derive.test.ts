import { describe, expect, it } from 'vitest';
import { deriveActivity, DEFAULT_PHRASE, STALE_AFTER_MS } from '../derive.js';
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

describe('deriveActivity — the things this surface must never say', () => {
  it('never emits a percentage, a remaining, an eta, or a time left', () => {
    const matrix: DeriveInput[] = [
      input(),
      input({ trigger: 'Morning email pass' }),
      input({ tool: { phrase: 'Reading email' } }),
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
