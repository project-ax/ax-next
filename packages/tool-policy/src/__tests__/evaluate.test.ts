import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluate.js';
import type { PolicyRule } from '../types.js';

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
    });
  });

  it('falls through to the broad rule when the predicate does not hold', () => {
    expect(evaluate(RULES, { name: 'gmail_send', input: { intent: 'sales' } })).toEqual({
      verdict: 'hold',
      ruleId: 'test.send.any',
      capability: 'write to a customer',
    });
  });

  it('defaults to allow with no rule when nothing matches', () => {
    expect(evaluate(RULES, { name: 'Read', input: {} })).toEqual({
      verdict: 'allow',
      ruleId: null,
      capability: null,
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
