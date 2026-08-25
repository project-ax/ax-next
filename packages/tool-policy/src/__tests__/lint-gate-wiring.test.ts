/**
 * The gate has to actually CALL the lints, and nothing else asserted that.
 *
 * `capability-lint.test.ts` proves the pure functions fire and `rules.test.ts`
 * proves the shipped table is clean, but both would stay green if
 * `scripts/lint-capabilities.ts` stopped invoking `lintRuleEffect` — the CI gate
 * would go quiet and the only thing standing between an `outward` + `allow` rule
 * and main would be a manual counterfactual nobody re-runs. The whole point of
 * putting the check in the gate (rather than only in vitest) was that CI names
 * the offending rule id; an untested three-line loop is a thin place for that to
 * rest.
 *
 * A source-shape assertion, deliberately: running the script for real would mean
 * spawning tsx and feeding it a doctored rule table, and the thing worth pinning
 * is "the gate consults both lints", which is visible in the text. Same posture
 * as the drift guards under the repo's `scripts/__tests__/`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'lint-capabilities.ts',
);

describe('scripts/lint-capabilities.ts — the CI gate wiring', () => {
  const source = readFileSync(GATE, 'utf8');

  it('imports and calls both lints', () => {
    // Import AND call: importing without calling is exactly the shape a
    // half-finished refactor leaves behind.
    expect(source).toMatch(/import \{[^}]*\blintCapability\b[^}]*\} from/);
    expect(source).toMatch(/import \{[^}]*\blintRuleEffect\b[^}]*\} from/);
    expect(source).toMatch(/lintCapability\(/);
    expect(source).toMatch(/lintRuleEffect\(/);
  });

  it('exits non-zero when it finds a problem', () => {
    // Without this the gate could count failures, print them, and still exit 0
    // — a red that reads as green, which is the failure mode this repo keeps
    // paying for elsewhere.
    expect(source).toMatch(/process\.exit\(1\)/);
  });

  it('iterates the whole table rather than the first rule', () => {
    expect(source).toMatch(/for \(const rule of BUILTIN_RULES\)/);
  });
});
