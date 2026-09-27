import { describe, expect, it } from 'vitest';

import { isAgentContextSelfReport } from '../self-report.js';

/**
 * TASK-612. The fact below is the one walk TASK-607 measured the observer
 * storing, verbatim: a Rule saved mid-session had not reached the running
 * sandbox, the agent truthfully said it saw no rules, and the extractor
 * turned that snapshot of its own system prompt into a durable memory.
 */
const WALK_FACT = {
  subject: 'assistant',
  predicate: 'stated',
  object:
    'No rules have been given by the user; the only instructions came from the system bootstrap prompt (figuring out identity, writing identity files)',
};

describe('isAgentContextSelfReport', () => {
  it('flags the exact fact walk TASK-607 measured being stored', () => {
    expect(isAgentContextSelfReport(WALK_FACT)).toBe(true);
  });

  it.each([
    ['stated', 'No rules from you yet'],
    ['stated', 'no standing instructions from the user'],
    ['said', "doesn't have any memory of previous conversations"],
    ['stated', 'cannot remember prior sessions'],
    ['stated', 'has no saved memories about the user'],
    ['described', 'its instructions come only from the system prompt'],
    ['has_no_rules', 'from the user'],
    ['has_rules', 'none'],
    ['stated', 'The rules I was given by the user are: none'],
    ['stated', 'no rules have been set by the user'],
  ])('flags the assistant self-report %s | %s', (predicate, object) => {
    expect(isAgentContextSelfReport({ subject: 'assistant', predicate, object })).toBe(true);
  });

  it.each(['Assistant', 'the_assistant', 'AI assistant', 'agent'])(
    'treats %s as the agent speaking',
    (subject) => {
      expect(isAgentContextSelfReport({ ...WALK_FACT, subject })).toBe(true);
    },
  );

  it.each([
    // An assistant fact that merely MENTIONS rules is real content.
    ['assistant', 'listed', 'the rules of chess: no castling through check'],
    ['assistant', 'recommended_sealant', 'Mod Podge, to seal the newspaper flower vase'],
    ['assistant', 'explained', 'house rules for the rental: no parties after 10pm'],
    ['assistant', 'recommended', 'a memory foam pillow'],
    // Not the agent speaking: a person's own statement is theirs to keep.
    ['user', 'stated', 'no rules have been given by the user'],
    ['user', 'prefers', 'no memory foam pillows'],
    ['sam', 'has_no_rules', 'for weekend meetings'],
  ])('keeps %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(false);
  });
});
