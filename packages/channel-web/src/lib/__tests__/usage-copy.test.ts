import { describe, it, expect } from 'vitest';
import { UsageHttpError, type UsageStatus } from '../usage-admin';
import {
  DAILY_LIMIT_INVALID,
  TURNS_LIMIT_INVALID,
  failureMessage,
  formatUsd,
  personLabel,
  personSubline,
  shareOfLimit,
  statusLabel,
  summaryLine,
} from '../usage-copy';

describe('formatUsd', () => {
  it('always shows cents and groups thousands', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0.004)).toBe('$0.00');
  });
});

describe('summaryLine', () => {
  it('agrees in number', () => {
    expect(summaryLine({ users: 1, turns: 1, spendUsd: 0.25 })).toBe(
      '1 person, 1 message, about $0.25 estimated',
    );
    expect(summaryLine({ users: 0, turns: 0, spendUsd: 0 })).toBe(
      '0 people, 0 messages, about $0.00 estimated',
    );
    expect(summaryLine({ users: 12, turns: 1500, spendUsd: 42 })).toBe(
      '12 people, 1,500 messages, about $42.00 estimated',
    );
  });
});

describe('shareOfLimit', () => {
  it('says nothing when there is nothing to say', () => {
    expect(shareOfLimit(0, 5)).toBeNull();
    expect(shareOfLimit(1, 0)).toBeNull();
    expect(shareOfLimit(1, -5)).toBeNull();
  });

  it('rounds, calls a sliver "<1%", and does not clamp at 100', () => {
    expect(shareOfLimit(1.25, 5)).toBe('25% of limit');
    expect(shareOfLimit(0.01, 5)).toBe('<1% of limit');
    expect(shareOfLimit(5.5, 5)).toBe('110% of limit');
  });
});

describe('who a row is about', () => {
  const base = { userId: 'u-1', displayName: null, email: null };

  it('prefers the name, then the email, then the id', () => {
    expect(personLabel({ ...base, displayName: 'Sam', email: 's@x.co' })).toBe('Sam');
    expect(personLabel({ ...base, email: 's@x.co' })).toBe('s@x.co');
    expect(personLabel(base)).toBe('u-1');
  });

  it('treats a blank name as no name', () => {
    expect(personLabel({ ...base, displayName: '   ', email: 's@x.co' })).toBe('s@x.co');
    expect(personLabel({ ...base, displayName: '', email: '' })).toBe('u-1');
  });

  it('puts a smaller line under a NAME only', () => {
    expect(personSubline({ ...base, displayName: 'Sam', email: 's@x.co' })).toBe('s@x.co');
    expect(personSubline({ ...base, displayName: 'Sam' })).toBe('u-1');
    expect(personSubline({ ...base, email: 's@x.co' })).toBeNull();
    expect(personSubline(base)).toBeNull();
  });
});

describe('statusLabel', () => {
  it('says the four states in words', () => {
    expect(statusLabel('ok')).toBe('OK');
    expect(statusLabel('near-limit')).toBe('Close to limit');
    expect(statusLabel('at-limit')).toBe('At limit');
    expect(statusLabel('suspended')).toBe('Paused');
  });

  it('never prints a blank or an inherited function for a status it does not know', () => {
    expect(statusLabel('brand-new' as UsageStatus)).toBe('Unknown');
    expect(statusLabel('constructor' as UsageStatus)).toBe('Unknown');
    expect(statusLabel('__proto__' as UsageStatus)).toBe('Unknown');
  });
});

describe('limit range messages', () => {
  it('name the same bounds the server enforces', () => {
    expect(DAILY_LIMIT_INVALID).toBe('Enter an amount between $0.01 and $10,000.');
    expect(TURNS_LIMIT_INVALID).toBe('Enter a whole number between 1 and 100,000.');
  });
});

describe('failureMessage', () => {
  const what = "We couldn't do it.";

  it('says what happened, what state things are in, why, and the next step', () => {
    expect(
      failureMessage(what, new UsageHttpError(500), { settled: 'Nothing was changed.' }),
    ).toBe(
      "We couldn't do it. Nothing was changed. The server ran into a problem. Try again in a moment.",
    );
  });

  it('leaves out the closing "try again" when the screen already has that button', () => {
    expect(failureMessage(what, new UsageHttpError(500), { retry: null })).toBe(
      "We couldn't do it. The server ran into a problem.",
    );
  });

  it('gives a signed-out admin the step that helps, not "try again"', () => {
    expect(failureMessage(what, new UsageHttpError(401))).toBe(
      "We couldn't do it. Your session has ended. Sign in again, then come back here.",
    );
  });

  it('tells someone without the role to ask an admin', () => {
    expect(failureMessage(what, new UsageHttpError(403))).toContain('Ask an admin to help.');
  });

  it('explains a network failure without repeating the browser\'s message', () => {
    const msg = failureMessage(what, new TypeError('Failed to fetch'));
    expect(msg).toContain("We couldn't reach the server.");
    expect(msg).toContain('Check your connection');
    expect(msg).not.toContain('Failed to fetch');
  });

  it('gives the two codes with their own sentences those sentences, whole', () => {
    expect(failureMessage(what, new UsageHttpError(400, 'cannot-suspend-self'))).toBe(
      "You can't pause your own agents. Ask another admin to do it.",
    );
    const invalid = failureMessage(what, new UsageHttpError(400, 'invalid-limits'));
    expect(invalid).toContain("We couldn't save those limits.");
    expect(invalid).toContain('$0.01 to $10,000');
    expect(invalid).toContain('1 to 100,000');
  });

  it('shows an unknown server code plainly rather than hiding it', () => {
    expect(failureMessage(what, new UsageHttpError(409, 'stale-thing'))).toContain(
      'The server said: stale-thing.',
    );
  });

  it('does not mistake an inherited property for a code it knows', () => {
    // `serverError` is text off the wire. An object-literal lookup would answer
    // "constructor" with a function; the table is a Map, so it is just unknown.
    const msg = failureMessage(what, new UsageHttpError(400, 'constructor'));
    expect(msg).toContain('The server said: constructor.');
    expect(msg).not.toContain('function');
  });

  it('copes with something that is not an error at all', () => {
    expect(failureMessage(what, 'boom')).toBe("We couldn't do it. Try again in a moment.");
    expect(failureMessage(what, undefined)).toBe("We couldn't do it. Try again in a moment.");
  });
});
