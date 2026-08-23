/**
 * `readAlertVariant` — the one rule for how a failed read is drawn.
 *
 * These are not "does the switch switch" tests. Each one pins a sentence of the
 * rule in `lib/read-register.ts`, and each of those sentences was argued over
 * because three surfaces had already answered the same question three ways
 * (TASK-290). The mapping is the artefact `AgentView` imports next; if a future
 * card wants to move one of these, the argument to beat is in that file's
 * header, not here.
 */
import { describe, expect, it } from 'vitest';
import { readAlertVariant, type ReadOutcome } from '../lib/read-register';

describe('readAlertVariant', () => {
  /*
    A session that ran out is not a malfunction. Nothing broke, nobody files
    anything, and the only move available — sign in again — is not repair. Red
    would contradict the sentence sitting in it: `ui/alert.tsx` recolours the
    whole body, so `destructive` would render "Nothing has been decided without
    you" in the colour of something having gone wrong.
  */
  it('never reddens an expired session, whatever else is true', () => {
    expect(readAlertVariant('expired')).toBe('default');
    expect(readAlertVariant('expired', { retrying: true })).toBe('default');
    expect(readAlertVariant('expired', { retrying: false })).toBe('default');
  });

  /*
    The clause that settled the one genuine disagreement. `TodayView` and
    `AgentConversation` read through `useDecisionQueue`, which has no automatic
    retry — #456 gave one to `useConversationDecisions` only — so their first
    failure is already terminal and already red. The in-thread card is neutral
    for the few seconds an attempt is genuinely coming, and joins them after.
  */
  it('separates a failure something is still chasing from one nothing is', () => {
    expect(readAlertVariant('failed', { retrying: true })).toBe('default');
    expect(readAlertVariant('failed', { retrying: false })).toBe('destructive');
  });

  /*
    `retrying` is a claim about the CODE — the same discipline
    `DECISION_READ_RETRYING` follows. A caller with no retry mechanism omits the
    argument, and omitting it must not quietly buy the softer register: a
    surface that promises another attempt it is not making is the defect this
    epic keeps closing.
  */
  it('treats an unstated retry as no retry, not as a maybe', () => {
    expect(readAlertVariant('failed')).toBe('destructive');
    expect(readAlertVariant('failed', {})).toBe('destructive');
  });

  /*
    `gone` fails the `default` test on both clauses at once: nothing further is
    coming, and no action the reader can take repairs it. It is the kind no
    decisions surface produces today — it exists for `AgentView` (TASK-296),
    and it exists HERE so that surface does not invent an eighth register at its
    own call site. The retry flag is not an escape hatch for it: a "Try again"
    against a 404 is a control that cannot work.
  */
  it('gives a thing that is not there the terminal register, retry or not', () => {
    expect(readAlertVariant('gone')).toBe('destructive');
    expect(readAlertVariant('gone', { retrying: true })).toBe('destructive');
  });

  /*
    `ui/alert.tsx` offers exactly two variants and there is no warning tier, so
    every kind has to land on one of them. This is what stops a fourth kind
    being added with no register and defaulting to whatever `<Alert>` does.
  */
  it('answers for every kind it admits', () => {
    const kinds: ReadOutcome[] = ['expired', 'gone', 'failed'];
    for (const kind of kinds) {
      expect(['default', 'destructive']).toContain(readAlertVariant(kind));
    }
  });
});
