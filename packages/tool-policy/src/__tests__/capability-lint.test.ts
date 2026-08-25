import { describe, expect, it } from 'vitest';
import { lintCapability, lintRuleEffect } from '../capability-lint.js';

/**
 * `lintCapability` returns human-readable sentences, so the assertions match on
 * a substring rather than the whole string — `toContain` on an ARRAY is exact
 * element equality, which would pin the tests to the exact wording of every
 * error message and make a copy edit a test failure.
 */
function complains(clause: string, about: string): void {
  expect(lintCapability(clause)).toEqual(
    expect.arrayContaining([expect.stringContaining(about)]),
  );
}

describe('lintCapability', () => {
  it('accepts a bare infinitive clause', () => {
    expect(lintCapability('reply to scheduling requests')).toEqual([]);
  });

  it('rejects a leading "to"', () => {
    complains('to reply to scheduling requests', 'must not start with "to"');
  });

  it('rejects verdict wording — the frame comes from the verdict, not the text', () => {
    complains('never delete anything', 'contains a verdict word');
    complains('asks you before sending', 'contains a verdict word');
    complains('can reply to email', 'contains a verdict word');
  });

  it('rejects a verdict word at either end of the clause', () => {
    // The check pads the clause with spaces before matching, so a verdict word
    // in first or last position is caught too — without the padding, ` never `
    // would miss `never delete anything` entirely.
    complains('delete anything you must', 'contains a verdict word');
    complains('always send the reply', 'contains a verdict word');
  });

  it('rejects a verdict word that is touching punctuation', () => {
    // Regression: the first implementation probed for ` ${word} ` on a
    // space-padded clause, so a verdict word next to a comma, hyphen or slash
    // slipped through. Filed under `allow`, the first of these renders as
    // "✓ Can never, ever delete anything — on its own" — the exact frame
    // contradiction the authored/generated split is supposed to make
    // unexpressible.
    complains('never, ever delete anything', 'contains a verdict word');
    complains('reply first-class post', 'contains a verdict word');
    complains('it can/cannot run', 'contains a verdict word');
    complains('(always) send the reply', 'contains a verdict word');
  });

  it('does not flag a verdict word buried inside a longer word', () => {
    // The boundary probe must not turn "candelabra" or "canvas" into a verdict
    // word — over-rejecting is the safe direction, but not THAT safe.
    expect(lintCapability('polish the candelabra')).toEqual([]);
    expect(lintCapability('stretch a canvas for you')).toEqual([]);
  });

  it('rejects tool identifiers', () => {
    complains('call linear__create_issue', 'contains a tool identifier');
    complains('run createIssue for you', 'contains a tool identifier');
    complains('call `web_search`', 'contains a tool identifier');
    // Single-underscore snake_case is what the ax-native tool names actually
    // look like (`web_search`, `request_capability`), so it must be caught
    // even without a backtick or a double underscore around it.
    complains('call web_search for you', 'contains a tool identifier');
  });

  it('rejects trailing punctuation — a clause is not a sentence', () => {
    complains('reply to scheduling requests.', 'must not end with punctuation');
  });

  it('rejects leading or trailing whitespace', () => {
    complains(' reply to scheduling requests', 'leading or trailing whitespace');
  });

  it('rejects clauses over 60 characters', () => {
    complains('x'.repeat(61), 'longer than 60 characters');
  });

  it('rejects an empty clause', () => {
    complains('   ', 'is empty');
  });

  it('reports only "is empty" for an empty clause', () => {
    // An empty clause must not also be reported as "starts with to" etc. —
    // every downstream check would be reasoning about nothing.
    expect(lintCapability('')).toEqual(['is empty']);
  });
});

describe('lintRuleEffect (TASK-263)', () => {
  /*
    The point of these fixtures is NON-VACUITY.

    The natural way to write this guard is a loop over `BUILTIN_RULES`
    asserting no `outward` rule is `allow` — and that passes today for the
    wrong reason, because no rule in the table is `outward` at all. It would be
    a check that cannot fail wearing the costume of a guard. So the linter is a
    pure function and these fixtures prove it actually fires; the table-wide
    assertion in rules.test.ts is the secondary check.
  */
  it('rejects an outward rule that is allowed', () => {
    expect(lintRuleEffect({ effect: 'outward', verdict: 'allow' })).toEqual([
      expect.stringContaining('outward'),
    ]);
  });

  it('accepts an outward rule that is held or denied', () => {
    expect(lintRuleEffect({ effect: 'outward', verdict: 'hold' })).toEqual([]);
    expect(lintRuleEffect({ effect: 'outward', verdict: 'deny' })).toEqual([]);
  });

  it('accepts a spending rule that is allowed — metered spend is not an outward effect', () => {
    // The asymmetry this whole design rests on. If this ever starts failing,
    // web_search holds on every call and the gate gets turned off.
    expect(lintRuleEffect({ effect: 'spends', verdict: 'allow' })).toEqual([]);
  });

  it('accepts an unclassified rule — omitted effect is not an error', () => {
    // Most rules are neither outward nor spending, and requiring the field
    // would be 20 rows of `effect: undefined` noise. The cost is that omitted
    // and unclassified are indistinguishable; see the ToolEffect doc.
    expect(lintRuleEffect({ verdict: 'allow' })).toEqual([]);
  });
});
