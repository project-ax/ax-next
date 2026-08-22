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
  // Pad with spaces so a verdict word in first or last position still matches
  // the ` word ` probe.
  const lower = ` ${trimmed.toLowerCase()} `;
  for (const w of VERDICT_WORDS) {
    if (lower.includes(` ${w} `)) {
      errs.push(`contains a verdict word ("${w}") — the verdict supplies the frame`);
      break;
    }
  }
  if (TOOL_IDENT.test(trimmed)) {
    errs.push('contains a tool identifier — say what it does, not what it calls');
  }
  return errs;
}
