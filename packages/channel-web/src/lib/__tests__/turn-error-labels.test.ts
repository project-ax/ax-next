import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TURN_ERROR,
  ERROR_LABELS,
  MAX_DETAIL_CHARS,
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
