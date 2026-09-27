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
    // First-person negations: the likeliest way a running agent says it.
    ['stated', "I haven't been given any rules"],
    ['stated', 'I have not been given any rules'],
    ['stated', "I wasn't given any rules"],
    ['stated', 'I was not given any rules'],
    ['stated', "hasn't received any instructions"],
    ['stated', 'I never received any instructions'],
    ['stated', 'has not been told any rules'],
    // "for/of/on/about" + the agent's OWN scope is still a self-report; only a
    // topic after it ("rules of chess") is content.
    ['stated', 'I have no rules for this conversation'],
    ['stated', 'no rules for you yet'],
    ['stated', 'I have no instructions for this task'],
    ['stated', 'I have not been given any instructions for our chat'],
    ["stated", "I don't have any rules about how to respond"],
    ['stated', 'there are no instructions on what to do'],
    ['stated', 'the system prompt is all I was given'],
    // A self-tied mention of its prompt is still about its own context.
    ['stated', 'the only instructions came from the system bootstrap prompt'],
    ['stated', 'follows only what is in its system prompt'],
  ])('flags the assistant self-report %s | %s', (predicate, object) => {
    expect(isAgentContextSelfReport({ subject: 'assistant', predicate, object })).toBe(true);
  });

  it.each(['ai', 'bot', 'sourdough'])('does not treat the topic subject %s as the agent', (subject) => {
    expect(isAgentContextSelfReport({ ...WALK_FACT, subject })).toBe(false);
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
    // "system prompt" as a TOPIC the person asked about is real content.
    ['assistant', 'explained', 'how to write a good system prompt for GPT models'],
    ['assistant', 'described', 'a system prompt injection attack technique'],
    ['assistant', 'recommended', 'never given any rules of thumb for sourdough — weigh the flour'],
    // Not the agent speaking: a person's own statement is theirs to keep.
    ['user', 'stated', 'no rules have been given by the user'],
    ['user', 'prefers', 'no memory foam pillows'],
    ['sam', 'has_no_rules', 'for weekend meetings'],
  ])('keeps %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(false);
  });
});
