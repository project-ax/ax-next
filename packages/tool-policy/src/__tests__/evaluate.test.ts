import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluate.js';
import { EvaluateResultSchema, type PolicyRule } from '../types.js';

const RULES: PolicyRule[] = [
  {
    id: 'test.send.scheduling',
    match: { tool: 'gmail_send', when: { field: 'intent', equals: 'scheduling' } },
    verdict: 'allow',
    capability: 'reply to scheduling requests',
    subject: 'agent',
  },
  {
    id: 'test.send.any',
    match: { tool: 'gmail_send' },
    verdict: 'hold',
    capability: 'write to a customer',
    subject: 'agent',
  },
  {
    id: 'test.delete',
    match: { tool: 'gmail_delete' },
    verdict: 'deny',
    capability: 'delete anything',
    subject: 'agent',
  },
];

describe('evaluate', () => {
  it('takes the FIRST matching rule, so a narrow rule can precede a broad one', () => {
    expect(evaluate(RULES, { name: 'gmail_send', input: { intent: 'scheduling' } })).toEqual({
      verdict: 'allow',
      ruleId: 'test.send.scheduling',
      capability: 'reply to scheduling requests',
      irreversible: false,
      effect: [],
    });
  });

  it('falls through to the broad rule when the predicate does not hold', () => {
    expect(evaluate(RULES, { name: 'gmail_send', input: { intent: 'sales' } })).toEqual({
      verdict: 'hold',
      ruleId: 'test.send.any',
      capability: 'write to a customer',
      irreversible: false,
      effect: [],
    });
  });

  it('defaults to allow with no rule when nothing matches', () => {
    expect(evaluate(RULES, { name: 'Read', input: {} })).toEqual({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
      effect: [],
    });
  });

  it('does not match a predicate against a non-primitive field', () => {
    expect(
      evaluate(RULES, { name: 'gmail_send', input: { intent: { nested: 'scheduling' } } }),
    ).toMatchObject({ ruleId: 'test.send.any' });
  });

  it('does not match a predicate when the input is not an object at all', () => {
    // A tool whose input arrived as a string / null must not blow up and must
    // not satisfy a `when`.
    expect(evaluate(RULES, { name: 'gmail_send', input: null })).toMatchObject({
      ruleId: 'test.send.any',
    });
    expect(evaluate(RULES, { name: 'gmail_send', input: 'scheduling' })).toMatchObject({
      ruleId: 'test.send.any',
    });
  });

  it('compares primitives strictly — "1" does not satisfy equals: 1', () => {
    const rules: PolicyRule[] = [
      {
        id: 'test.count',
        match: { tool: 'send', when: { field: 'count', equals: 1 } },
        verdict: 'deny',
        capability: 'send exactly one thing',
        subject: 'agent',
      },
    ];
    expect(evaluate(rules, { name: 'send', input: { count: '1' } })).toMatchObject({
      ruleId: null,
    });
    expect(evaluate(rules, { name: 'send', input: { count: 1 } })).toMatchObject({
      ruleId: 'test.count',
    });
  });

  it('does not let a prototype key masquerade as a matching field', () => {
    // A rule keyed on a field name that also exists on `Object.prototype`
    // must not read the prototype's value and fire on every call — that is a
    // policy bypass. `evaluate` checks own-properties before reading.
    const rules: PolicyRule[] = [
      {
        id: 'test.proto',
        match: { tool: 'send', when: { field: 'constructor', equals: 'x' } },
        verdict: 'allow',
        capability: 'send a thing',
        subject: 'agent',
      },
    ];
    expect(evaluate(rules, { name: 'send', input: {} })).toMatchObject({ ruleId: null });
  });

  it('is pure — evaluating twice yields the same answer and mutates nothing', () => {
    const call = { name: 'gmail_send', input: { intent: 'scheduling' } };
    const before = JSON.stringify(RULES);
    expect(evaluate(RULES, call)).toEqual(evaluate(RULES, call));
    expect(JSON.stringify(RULES)).toBe(before);
  });
});

describe('evaluate — irreversible', () => {
  // Locally-constructed rules only. BUILTIN_RULES documents that none of
  // today's seeded rules is irreversible — do not add one there for this test.
  const IRREVERSIBLE_RULES: PolicyRule[] = [
    {
      id: 'test.wire.transfer',
      match: { tool: 'wire_transfer' },
      verdict: 'hold',
      capability: 'move money out of the account',
      subject: 'agent',
      irreversible: true,
    },
    {
      id: 'test.send.any',
      match: { tool: 'gmail_send' },
      verdict: 'hold',
      capability: 'write to a customer',
      subject: 'agent',
    },
  ];

  it('reports irreversible: true when the matched rule says approving cannot be taken back', () => {
    expect(evaluate(IRREVERSIBLE_RULES, { name: 'wire_transfer', input: {} })).toEqual({
      verdict: 'hold',
      ruleId: 'test.wire.transfer',
      capability: 'move money out of the account',
      irreversible: true,
      effect: [],
    });
  });

  it('reports irreversible: false when the matched rule omits the flag', () => {
    expect(
      evaluate(IRREVERSIBLE_RULES, { name: 'gmail_send', input: {} }),
    ).toEqual({
      verdict: 'hold',
      ruleId: 'test.send.any',
      capability: 'write to a customer',
      irreversible: false,
      effect: [],
    });
  });

  it('reports irreversible: false when no rule matches', () => {
    expect(evaluate(IRREVERSIBLE_RULES, { name: 'Read', input: {} })).toEqual({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
      effect: [],
    });
  });

  it('EvaluateResultSchema.parse keeps the irreversible key — a z.object strips undeclared keys', () => {
    const result = evaluate(IRREVERSIBLE_RULES, { name: 'wire_transfer', input: {} });
    const parsed = EvaluateResultSchema.parse(result);
    expect(parsed).toHaveProperty('irreversible', true);
    expect(parsed).toEqual(result);
  });
});

describe('evaluate — effect (TASK-383)', () => {
  /*
    `effect` is DISCLOSURE, not a second gate: `verdict` already decided
    whether the call happens. These tests pin the two branches of one principle
    — never answer silence where the table has spoken about this tool — and the
    second branch is the whole reason the field exists.

    Every assertion below uses `toEqual` on the array. `toBe`/`===` against a
    member string is the mistake TASK-330 already made once: an array silently
    fails a string comparison, so the guard goes quiet while still wearing the
    costume of one — and it goes quiet in the UNDER-disclosing direction.
  */
  const EFFECT_RULES: PolicyRule[] = [
    {
      // Declared `['spends', 'outward']` and deliberately NOT alphabetically:
      // a result that came back sorted would pass a laxer assertion while
      // having invented an order the author never wrote.
      id: 'test.extract',
      match: { tool: 'extract' },
      verdict: 'hold',
      capability: 'read a web page',
      subject: 'agent',
      effect: ['spends', 'outward'],
    },
    {
      id: 'test.post.public',
      match: { tool: 'post', when: { field: 'visibility', equals: 'public' } },
      verdict: 'hold',
      capability: 'post something where anyone can see it',
      subject: 'agent',
      effect: ['outward'],
    },
    {
      // The broad sibling. Its presence is what makes `post` fully described,
      // so `post` never takes the mechanical base-row path — the contrast with
      // `charge` below, and the reason the union cannot leak onto a tool that
      // has an unconditional rule.
      id: 'test.post.any',
      match: { tool: 'post' },
      verdict: 'hold',
      capability: 'post something',
      subject: 'agent',
    },
    {
      // THE BASE-ROW SHAPE: every rule naming `charge` carries a `when`, so
      // the rail gives the tool a mechanical base row and asks us about an
      // empty input — the one input no `PredicateSpec` can match.
      id: 'test.charge.usd',
      match: { tool: 'charge', when: { field: 'currency', equals: 'usd' } },
      verdict: 'hold',
      capability: 'charge a card in dollars',
      subject: 'agent',
      effect: ['spends'],
    },
    {
      id: 'test.charge.eur',
      match: { tool: 'charge', when: { field: 'currency', equals: 'eur' } },
      verdict: 'hold',
      capability: 'charge a card in euros',
      subject: 'agent',
      effect: ['spends', 'outward'],
    },
    {
      id: 'test.read',
      match: { tool: 'read_file' },
      verdict: 'allow',
      capability: 'read a file',
      subject: 'agent',
    },
  ];

  it('carries the matched rule set, in the order the rule declares it', () => {
    // The rule that answered the verdict is the thing speaking, same as
    // `ruleId` / `capability` / `irreversible`.
    expect(evaluate(EFFECT_RULES, { name: 'extract', input: { url: 'x' } })).toEqual({
      verdict: 'hold',
      ruleId: 'test.extract',
      capability: 'read a web page',
      irreversible: false,
      effect: ['spends', 'outward'],
    });
  });

  it('carries a CONDITIONAL rule set when its predicate holds', () => {
    // A `when` rule is still a rule that spoke. Nothing about the predicate
    // makes its disclosure less true for the call it caught.
    expect(
      evaluate(EFFECT_RULES, { name: 'post', input: { visibility: 'public' } }),
    ).toMatchObject({ ruleId: 'test.post.public', effect: ['outward'] });
  });

  it('unions the declared effects when NO rule matched — the base-row case', () => {
    /*
      THE CARD. `fullyDescribedTools` omits `charge` (every rule naming it is
      conditional), so the rail builds a mechanical base row for it and gets
      the verdict by asking about `input: {}`. Answering the matched rule's
      effect alone would answer `[]` at exactly the call site this field exists
      to serve, and the row would render no disclosure while the call still
      spends the money and still acts outward.

      `ruleId: null` is unchanged: no rule spoke to the VERDICT and we do not
      pretend one did. `effect` is the one field that reads wider, because a
      predicate gates the verdict, not what the call does in the world.
    */
    expect(evaluate(EFFECT_RULES, { name: 'charge', input: {} })).toEqual({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
      effect: ['spends', 'outward'],
    });
  });

  it('dedupes the union and keeps table order across two conditional rules', () => {
    // A real call that missed BOTH predicates rather than an empty probe —
    // same answer, because the union is about the TOOL and not the input.
    //
    // `spends` is declared by both rules and must appear ONCE, ahead of
    // `outward`, which only the second declares. Sorted output would coincide
    // here; the order assertion that cannot coincide is in the matched-rule
    // test above, and this one is aimed at the duplicate.
    const out = evaluate(EFFECT_RULES, { name: 'charge', input: { currency: 'gbp' } });
    expect(out.ruleId).toBe(null);
    expect(out.effect).toEqual(['spends', 'outward']);
  });

  it('answers [] for a tool no rule names at all', () => {
    // The union is scoped to the gap and cannot widen past it: there is
    // nothing to union, so silence is the honest answer rather than a
    // fabricated one. This is half of what stops a benign tool inheriting a
    // sibling's disclosure; the broad-rule case above is the other half.
    expect(evaluate(EFFECT_RULES, { name: 'unruled_tool', input: {} }).effect).toEqual([]);
  });

  it('answers [] when the matched rule declares nothing', () => {
    // OMITTED ON A RULE MEANS UNCLASSIFIED, and `[]` here means the same
    // thing. It does not mean harmless, and nothing downstream may read it
    // that way.
    expect(evaluate(EFFECT_RULES, { name: 'read_file', input: {} })).toMatchObject({
      ruleId: 'test.read',
      effect: [],
    });
  });

  it('hands out a COPY — a caller cannot rewrite the rule table through it', () => {
    /*
      `evaluate` is pure, and returning `rule.effect` by reference would make
      it pure only until somebody pushed onto the answer: the rule table is a
      module-level constant shared by every later call, `readonly` in the type
      system and nowhere else, so one caller appending to or emptying its
      result would silently rewrite a SECURITY CLAIM for everybody after it.
      `plugin.ts` already guards the rail rows against the same hazard.
    */
    const first = evaluate(EFFECT_RULES, { name: 'extract', input: {} });
    first.effect.push('outward');
    first.effect.length = 0;
    expect(evaluate(EFFECT_RULES, { name: 'extract', input: {} }).effect).toEqual([
      'spends',
      'outward',
    ]);
    expect(EFFECT_RULES[0]!.effect).toEqual(['spends', 'outward']);
  });

  it('EvaluateResultSchema.parse keeps the effect key — a z.object strips undeclared keys', () => {
    // The same failure mode the `irreversible` test above guards: the field is
    // on the interface, the schema forgets it, and it vanishes on the way out
    // of the bus while every test on the returned OBJECT stays green.
    // `tool-policy.canary.test.ts` runs that mutant through a real bus; this
    // one fails faster and names the schema directly.
    const result = evaluate(EFFECT_RULES, { name: 'extract', input: {} });
    expect(EvaluateResultSchema.parse(result)).toEqual(result);
    expect(EvaluateResultSchema.parse(result).effect).toEqual(['spends', 'outward']);
  });
});
