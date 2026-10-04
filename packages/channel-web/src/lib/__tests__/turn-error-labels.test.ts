import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TURN_ERROR,
  ERROR_LABELS,
  MAX_DETAIL_CHARS,
  turnErrorOpensConnectors,
  turnErrorText,
} from '../turn-error-labels';

/*
  The four reason codes the usage-limits gate vetoes a turn with (TASK-692).
  The host refuses a message with the reason `chat:start:<code>`; what a person
  reads is decided HERE, and the copy is final — it was written for the reader
  who hits a limit with no idea one existed, so a reword is a product change,
  not a tidy-up.
*/
const USAGE_LIMIT_COPY: ReadonlyArray<readonly [string, string]> = [
  [
    'chat:start:usage-limit-daily',
    "You've reached your daily usage limit. It frees up gradually over the next 24 hours. If you need more right now, ask an admin to raise it.",
  ],
  [
    'chat:start:usage-limit-rate',
    "You're sending messages faster than we can keep up with. Give it a few minutes, then try again.",
  ],
  [
    'chat:start:usage-suspended',
    'Your agents are paused right now. Ask an admin to turn them back on.',
  ],
  [
    'chat:start:usage-check-unavailable',
    "We couldn't check your usage just now, so we held this message to be safe. Try again in a moment.",
  ],
];

describe('turnErrorText — usage limits (TASK-692)', () => {
  for (const [code, sentence] of USAGE_LIMIT_COPY) {
    it(`says the authored sentence for ${code}`, () => {
      expect(ERROR_LABELS[code]).toBe(sentence);
      expect(turnErrorText(code)).toBe(sentence);
    });
  }

  it('never falls back to the generic "stopped unexpectedly" line for a limit', () => {
    for (const [code] of USAGE_LIMIT_COPY) {
      expect(turnErrorText(code)).not.toBe(DEFAULT_TURN_ERROR);
    }
  });

  it('appends the optional detail line under the sentence, clamped', () => {
    const [code, sentence] = USAGE_LIMIT_COPY[0]!;
    expect(turnErrorText(code, 'resets soon')).toBe(`${sentence}\nresets soon`);
    const long = 'x'.repeat(MAX_DETAIL_CHARS + 50);
    expect(turnErrorText(code, long)).toBe(
      `${sentence}\n${'x'.repeat(MAX_DETAIL_CHARS)}`,
    );
  });

  it('gives a code we do not know the generic line, not a usage sentence', () => {
    expect(turnErrorText('chat:start:usage-limit-monthly')).toBe(DEFAULT_TURN_ERROR);
  });

  it('still answers an inherited Object.prototype key with the generic line', () => {
    // The label table is an object literal: a plain lookup of `toString` finds
    // the inherited function and would print `function toString() { [native
    // code] }` at a reader. Adding keys must not have weakened that guard.
    for (const inherited of ['toString', 'constructor', 'valueOf', '__proto__']) {
      expect(turnErrorText(inherited)).toBe(DEFAULT_TURN_ERROR);
    }
  });
});

/*
  The storage limit's front door (TASK-690). @ax/disk-quota vetoes a turn at
  `chat:start` with the reason `storage-full` once a person's storage is full,
  so the sentence lives here. It must not promise a remedy that does not exist:
  only deleting a whole agent gives space back (no smaller chore does), so it
  says "ask an admin".
*/
describe('turnErrorText — storage full (TASK-690)', () => {
  const code = 'chat:start:storage-full';

  it('says the authored sentence, not the generic "stopped unexpectedly" line', () => {
    expect(ERROR_LABELS[code]).toBe(
      'Your storage is full, so nothing new can be saved right now. Ask an admin for more room, then try again.',
    );
    expect(turnErrorText(code)).toBe(ERROR_LABELS[code]);
    expect(turnErrorText(code)).not.toBe(DEFAULT_TURN_ERROR);
  });

  it('does not tell anyone to delete anything (no small chore frees space)', () => {
    expect(turnErrorText(code).toLowerCase()).not.toContain('delete');
  });
});

describe('turnErrorText — a connector sign-in expired (TASK-713)', () => {
  it('points at Connectors instead of the generic "stopped unexpectedly" line', () => {
    const text = turnErrorText('connector-needs-reconnect');
    expect(text).not.toBe(DEFAULT_TURN_ERROR);
    expect(text).toBe(
      'One of this agent’s connectors needs you to sign in again. Open Connectors, reconnect it, then retry.',
    );
  });

  it('keeps the generic line for an ordinary session-open failure', () => {
    expect(turnErrorText('proxy-open-failed')).toBe(DEFAULT_TURN_ERROR);
  });
});

describe('turnErrorText — a connector nobody signed in to yet (TASK-796)', () => {
  it('says "sign in", not "reconnect", and points at Connectors', () => {
    const text = turnErrorText('connector-needs-sign-in');
    expect(text).not.toBe(DEFAULT_TURN_ERROR);
    expect(text).toBe(
      'One of this agent’s connectors isn’t signed in yet. Open Connectors, sign in, then retry.',
    );
    expect(text.toLowerCase()).not.toContain('reconnect');
  });

  it('marks exactly the two connector reasons as fixed on the Connectors tab', () => {
    expect(turnErrorOpensConnectors('connector-needs-sign-in')).toBe(true);
    expect(turnErrorOpensConnectors('connector-needs-reconnect')).toBe(true);
    for (const other of ['proxy-open-failed', 'chat-run-timeout', 'toString', '', null, undefined]) {
      expect(turnErrorOpensConnectors(other)).toBe(false);
    }
  });
});
