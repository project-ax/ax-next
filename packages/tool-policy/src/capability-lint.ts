import type { ToolEffect } from './types.js';
// Shape lint for the `capability` clause on a PolicyRule.
//
// The clause is HALF a sentence: the verdict supplies the frame ("Can X — on
// its own" / "Can X — asks you first" / "Cannot X"). That split closes a real
// bug class — someone edits a phrase for clarity and it now contradicts the
// verdict it is filed under. With the frame generated, that is unexpressible,
// and this lint is what keeps the authored half from smuggling a frame back in.
//
// Run by a unit test AND by CI over the whole rule table
// (`scripts/lint-capabilities.ts`), so a rule with a bad clause cannot merge.
// The CI script exists on top of the unit test so the failure names the
// offending rule in the CI log rather than burying it in a vitest diff.

/**
 * Words that belong to the FRAME, not to the clause. `ask` / `asks` is here
 * even though it collides with a legitimate English verb ("ask you a
 * question") — the collision is the point: a clause that reads as a frame is
 * exactly what this lint exists to stop, and rewording is cheap. See the
 * `builtins.ask-user-question` rule in rules.ts for the one place that bit.
 */
const VERDICT_WORDS = [
  'never',
  'always',
  'asks',
  'ask',
  'can',
  'cannot',
  "can't",
  'may',
  'must',
  'allowed',
  'denied',
  'permitted',
  'blocked',
  'on its own',
  'first',
];

/**
 * Anything that looks like an identifier rather than English:
 *   - an underscore anywhere (`web_search`, `linear__create_issue`) — the
 *     ax-native tool names are snake_case, and English prose in a ≤60-char
 *     clause has none;
 *   - a backtick, i.e. someone quoting code;
 *   - a camelCase token (`createIssue`).
 */
const TOOL_IDENT = /_|`|\b[a-z]+[A-Z][a-zA-Z]*\b/;

export const CAPABILITY_MAX_CHARS = 60;

/**
 * Word-boundary probe for one verdict word.
 *
 * This deliberately does NOT use ` ${w} ` on a space-padded clause. That is the
 * obvious implementation and it is evaded by ordinary punctuation: `"never,
 * ever delete anything"`, `"reply first-class post"` and `"it can/cannot run"`
 * all sail through, because the verdict word is touching a comma, a hyphen or a
 * slash rather than a space. Filed under `allow`, the first of those renders as
 * `✓ Can never, ever delete anything — on its own` — the exact frame
 * contradiction §4.3.1 claims is unexpressible.
 *
 * `\b` treats every non-word character as a boundary, which closes all three.
 * It over-rejects a legitimate hyphenated "first-class"; that is the direction
 * we want to be wrong in on a security claim, and rewording is cheap.
 */
function verdictWordProbe(word: string): RegExp {
  // Only `can't` carries a non-word character, and `'` is not a regex
  // metacharacter — but escape anyway so adding a word later cannot quietly
  // turn into a pattern.
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

export function lintCapability(clause: string): string[] {
  const errs: string[] = [];
  const trimmed = clause.trim();

  if (trimmed.length === 0) {
    // Return early: every check below reasons about the words in the clause,
    // and an empty clause has none. Reporting six derived complaints about
    // nothing would bury the one that matters.
    errs.push('is empty');
    return errs;
  }
  if (trimmed.length > CAPABILITY_MAX_CHARS) {
    errs.push(`is longer than ${CAPABILITY_MAX_CHARS} characters`);
  }
  if (trimmed !== clause) {
    errs.push('has leading or trailing whitespace');
  }
  if (/^to\s/i.test(trimmed)) {
    errs.push('must not start with "to" — the clause is a bare infinitive');
  }
  if (/[.!?]$/.test(trimmed)) {
    errs.push('must not end with punctuation — it is a clause, not a sentence');
  }
  for (const w of VERDICT_WORDS) {
    if (verdictWordProbe(w).test(trimmed)) {
      errs.push(`contains a verdict word ("${w}") — the verdict supplies the frame`);
      break;
    }
  }
  if (TOOL_IDENT.test(trimmed)) {
    errs.push('contains a tool identifier — say what it does, not what it calls');
  }
  return errs;
}

/**
 * The rule-shape half of the lint: an `outward` rule may not be `allow`.
 *
 * Why this is a lint and not a type. Making it unrepresentable would need
 * `PolicyRule` to become a discriminated union over the verdict, which every
 * consumer that reads `rule.verdict` generically would then have to narrow —
 * a large change to make one combination unwriteable. A lint in the CI gate
 * catches it just as early, names the rule in the log, and leaves the type flat.
 *
 * WHAT THIS DOES NOT COVER, stated because the gap is the more dangerous half:
 * a tool with NO rule is unclassified, so it has no `effect` for this to check
 * and falls through to `allow`. See the fall-through comment in `evaluate.ts`.
 * This guards the table against a bad row; it cannot guard against an absent
 * one.
 */
export function lintRuleEffect(rule: {
  effect?: ToolEffect;
  verdict: string;
}): string[] {
  if (rule.effect === 'outward' && rule.verdict === 'allow') {
    return [
      'declares effect: "outward" but verdict: "allow" — a call a third party ' +
        'sees, or that cannot be taken back, must be held or denied. Change the ' +
        'verdict, or if it is only metered spend with no outward effect, declare ' +
        'effect: "spends" instead.',
    ];
  }
  return [];
}
