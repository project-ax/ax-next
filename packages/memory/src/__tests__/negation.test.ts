import { describe, expect, it } from 'vitest';

import type { ExtractedFact } from '../extract.js';
import { dropNegatedFacts, isNegatedFact, negationIndex } from '../negation.js';
import { SLOT_SYNONYMS } from '../slots.js';

/**
 * TASK-652 — the negation guard's fixture eval.
 *
 * The extractor is an LLM and the CI suite never calls one, so each case is a
 * dialogue plus the fact an extractor could emit for it — the misreading we
 * are guarding against, the faithful reading, or a control. The live
 * counterpart is `packages/memory/scripts/negation-eval.mjs` (opt-in).
 */

const fact = (predicate: string, object: string, subject = 'user'): ExtractedFact => ({
  subject,
  predicate,
  object,
  validStart: '2026-09-28T00:00:00.000Z',
});

const dropped = (dialogue: string, f: ExtractedFact): boolean =>
  isNegatedFact(f, negationIndex(dialogue));

describe('a negated statement never yields the positive fact', () => {
  const MISREADINGS: Array<[dialogue: string, predicate: string, object: string]> = [
    ['user: I never lived in Denver.', 'lives_in', 'Denver'],
    ['user: I never lived in Denver.', 'lived_in', 'Denver'],
    ['user: Not Denver anymore.', 'lives_in', 'Denver'],
    ["user: I don't live in Denver.", 'lives_in', 'Denver'],
    ['user: I do not live in Denver.', 'lives_in', 'Denver'],
    // A curly apostrophe is how a phone keyboard spells it.
    ['user: I don’t live in Denver.', 'lives_in', 'Denver'],
    ['user: I no longer live in Denver, Colorado.', 'lives_in', 'Denver, Colorado'],
    ['user: I never lived in Denver, Colorado.', 'lives_in', 'Denver, Colorado'],
    ["user: I've never worked at Acme Corp.", 'works_at', 'Acme Corp'],
    ["user: My name isn't Robert.", 'name', 'Robert'],
    ['user: I used to live in Denver.', 'lives_in', 'Denver'],
    ['user: I have never in my whole life lived in Denver.', 'lives_in', 'Denver'],
    ['user: Neither Denver nor Boulder.', 'lives_in', 'Boulder'],
    ["user: I'm not from Denver.", 'is_from', 'Denver'],
    ['user: I cannot say I live in Denver.', 'lives_in', 'Denver'],
    // The value's possessive is the same word.
    ["user: I've never been a Denver's-fan type.", 'lives_in', 'Denver'],
    // Review round 1: a two-letter value is still a value.
    ["user: I don't live in LA.", 'lives_in', 'LA'],
    ["user: I don't live in the UK anymore.", 'lives_in', 'UK'],
    // Review round 1: a common word of the value said elsewhere ("a new
    // plan") does not vouch for the whole value, which was only negated.
    ["user: I don't live in New York. I need a new plan.", 'lives_in', 'New York'],
    ["user: I never lived in New York City. York is a nice name.", 'lives_in', 'New York City'],
    ['user: I have never worked at Bank of America. My bank is local.', 'works_at', 'Bank of America'],
  ];

  it.each(MISREADINGS)('%s  ->  %s | %s is dropped', (dialogue, predicate, object) => {
    expect(dropped(dialogue, fact(predicate, object))).toBe(true);
  });

  // The ones that matter most: a slot fact closes the previous value and, when
  // user-sourced, resurfaces a retracted one (TASK-648).
  it('every slot synonym is affirmative, so a slotted misreading always drops', () => {
    for (const relation of SLOT_SYNONYMS.keys()) {
      const predicate = relation.replace(/ /g, '_');
      expect(dropped("user: I don't have Denver there.", fact(predicate, 'Denver'))).toBe(true);
    }
  });
});

describe('a faithful reading of the negation is kept', () => {
  const FAITHFUL: Array<[dialogue: string, predicate: string, object: string]> = [
    ['user: I never lived in Denver.', 'never_lived_in', 'Denver'],
    ["user: I don't live in Denver.", 'does_not_live_in', 'Denver'],
    ["user: I don't live in Denver.", 'doesnt_live_in', 'Denver'],
    ["user: I don't like coffee.", 'dislikes', 'coffee'],
    ['user: Not Denver anymore.', 'formerly_lived_in', 'Denver'],
    ['user: I used to live in Denver.', 'previously_lived_in', 'Denver'],
    ["user: I don't live in Denver.", 'stated', 'not Denver'],
    ["user: I won't eat shellfish.", 'avoids', 'shellfish'],
  ];

  it.each(FAITHFUL)('%s  ->  %s | %s is kept', (dialogue, predicate, object) => {
    expect(dropped(dialogue, fact(predicate, object))).toBe(false);
  });
});

describe('a real positive statement is kept (controls)', () => {
  const CONTROLS: Array<[dialogue: string, predicate: string, object: string]> = [
    ['user: I live in Denver.', 'lives_in', 'Denver'],
    ['user: Actually I do live in Denver, Colorado.', 'lives_in', 'Denver, Colorado'],
    // "No," is an answer, not a negation of what follows.
    ['user: No, I live in Denver.', 'lives_in', 'Denver'],
    ['user: No, Denver.', 'lives_in', 'Denver'],
    ["user: I don't live in Boston, I live in Denver.", 'lives_in', 'Denver'],
    ["user: I don't live in Boston anymore; I live in Denver now.", 'lives_in', 'Denver'],
    // Said both ways: an un-negated mention is evidence enough.
    ['user: I never lived in Denver.\nuser: Wait, actually I do live in Denver now.', 'lives_in', 'Denver'],
    ["user: I don't live in Boston and I work at Acme.", 'works_at', 'Acme'],
    ["user: I'm not sure, but I live in Denver.", 'lives_in', 'Denver'],
    // Idioms whose negation is not about the value.
    ["user: I can't wait to move to Denver.", 'plans_to_move_to', 'Denver'],
    ['user: I never thought I would love Denver this much.', 'loves', 'Denver'],
    ["user: I don't mind living in Denver.", 'lives_in', 'Denver'],
    ["user: I can't believe I live in Denver now.", 'lives_in', 'Denver'],
    ['user: No doubt Denver is home.', 'lives_in', 'Denver'],
    ['user: Not only Denver, I also love Boulder.', 'loves', 'Denver'],
    // Review round 1: staying-put idioms state where the person lives.
    ['user: I never want to leave Denver.', 'lives_in', 'Denver'],
    ["user: I can't see myself leaving Denver.", 'lives_in', 'Denver'],
    ['user: I never left Denver.', 'lives_in', 'Denver'],
    ['user: There is no place like Denver.', 'lives_in', 'Denver'],
    ["user: I wouldn't trade Denver for anywhere.", 'lives_in', 'Denver'],
    ['user: I have never been more at home than in Denver.', 'lives_in', 'Denver'],
    ['user: There is no better city than Denver.', 'lives_in', 'Denver'],
    // A multi-word value mentioned whole and un-negated is kept, even if one
    // of its words is also negated somewhere.
    ["user: I don't live in York. I live in New York.", 'lives_in', 'New York'],
    // Said whole both ways: the un-negated whole mention wins, as for Denver.
    ['user: I never lived in New York.\nuser: Wait, actually I do live in New York.', 'lives_in', 'New York'],
    // Its words said apart, one negated: no evidence the whole was negated.
    ["user: I don't live in Denver, I live in Boulder.", 'lives_in', 'Boulder, near Denver'],
    // A paraphrase: nothing in the dialogue to say it was negated.
    ['user: I never lived there.', 'lives_in', 'Denver'],
    // A negation somewhere else in the dialogue does not reach the value.
    ["user: I don't know. What should I see?\nassistant: I recommend Red Rocks.", 'recommended', 'Red Rocks', ],
  ];

  it.each(CONTROLS)('%s  ->  %s | %s is kept', (dialogue, predicate, object) => {
    expect(dropped(dialogue, fact(predicate, object))).toBe(false);
  });

  it('an assistant fact follows the same rule', () => {
    const dialogue = 'user: Where should I go?\nassistant: I would not recommend Denver in winter.';
    expect(dropped(dialogue, fact('recommended', 'Denver', 'assistant'))).toBe(true);
    expect(dropped(dialogue, fact('advised_against', 'Denver in winter', 'assistant'))).toBe(false);
  });
});

describe('known limitation, pinned so a change is deliberate', () => {
  // The guard reads words, not grammar: it cannot tell whose living is
  // negated. It drops — the direction slots.ts calls the safe one (an
  // unclosed slot is the measured status quo; a false positive closes a true
  // fact and, since TASK-648, can resurface a retracted one).
  it("another person's negation over the same value drops the speaker's fact", () => {
    expect(
      dropped("user: My sister doesn't live in Denver; I do.", fact('lives_in', 'Denver')),
    ).toBe(true);
    expect(dropped("user: My wife doesn't work at Google, I do.", fact('works_at', 'Google'))).toBe(
      true,
    );
  });

  // The whole dialogue is read, not only the attributed turn: an assistant
  // negating the value the person only paraphrased drops the fact too.
  it("the assistant's negation drops a fact the person only paraphrased", () => {
    expect(
      dropped(
        'user: I moved there last month.\nassistant: I would not recommend Denver traffic.',
        fact('lives_in', 'Denver'),
      ),
    ).toBe(true);
  });

  // Misses, in the safe direction (nothing dropped, the pre-guard behaviour).
  it('a value that is only a stop word, and "nothing", are not guarded', () => {
    expect(dropped("user: I don't live in the US.", fact('lives_in', 'US'))).toBe(false);
    expect(dropped('user: Nothing about Denver appeals to me.', fact('likes', 'Denver'))).toBe(false);
  });
});

describe('dropNegatedFacts', () => {
  it('drops only the misreadings and counts them', () => {
    const dialogue = "user: I don't live in Boston anymore, I live in Denver.";
    const out = dropNegatedFacts(
      [fact('lives_in', 'Boston'), fact('lives_in', 'Denver'), fact('formerly_lived_in', 'Boston')],
      dialogue,
    );
    expect(out.negated).toBe(1);
    expect(out.facts.map((f) => `${f.predicate}|${f.object}`)).toEqual([
      'lives_in|Denver',
      'formerly_lived_in|Boston',
    ]);
  });

  it('keeps extra fields on the facts it passes through', () => {
    const out = dropNegatedFacts(
      [{ ...fact('lives_in', 'Denver'), sourceRole: 'user' as const, sourceTurnId: 't1' }],
      'user: I live in Denver.',
    );
    expect(out.facts[0]).toMatchObject({ sourceRole: 'user', sourceTurnId: 't1' });
  });

  it('is linear on a hostile dialogue (untrusted text, runs on the host)', () => {
    const hostile = [
      'not '.repeat(50_000),
      "n't".repeat(50_000),
      'no '.repeat(50_000),
      'a'.repeat(200_000),
      "'".repeat(100_000),
      ', '.repeat(50_000),
    ].join('\n');
    const facts = Array.from({ length: 50 }, (_, i) => fact('lives_in', `Denver ${'x'.repeat(i)}`));
    const started = performance.now();
    dropNegatedFacts(facts, hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
