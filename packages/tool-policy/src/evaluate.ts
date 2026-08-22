import type { EvaluateResult, PolicyRule, PredicateSpec } from './types.js';

function matches(when: PredicateSpec | undefined, input: unknown): boolean {
  if (when === undefined) return true;
  if (typeof input !== 'object' || input === null) return false;
  // OWN properties only. Without this, a rule keyed on a field name that also
  // exists on `Object.prototype` (`constructor`, `toString`, `valueOf`) would
  // read the prototype's value for every call — a rule that fires on input it
  // was never given. The primitives-only check below happens to catch today's
  // prototype members (they are all functions), but that is a coincidence of
  // what `Object.prototype` contains, not a guarantee.
  if (!Object.prototype.hasOwnProperty.call(input, when.field)) return false;
  const actual = (input as Record<string, unknown>)[when.field];
  // Primitives only. A predicate that "matched" an object would be comparing
  // by reference and would silently never fire.
  if (
    typeof actual !== 'string' &&
    typeof actual !== 'number' &&
    typeof actual !== 'boolean'
  ) {
    return false;
  }
  return actual === when.equals;
}

/**
 * First match wins, so ordering in `rules.ts` is meaningful: narrow rules
 * precede broad ones. No rule matching is `allow` — the rule table is an
 * exception list over a system whose baseline reach is already bounded by the
 * tool catalog, the egress allowlist and the connector scoping (see AW-1).
 *
 * Pure and total: no clock, no I/O, no throw. `@ax/decisions` (AW-4) calls this
 * from inside a `tool:pre-call` subscriber, where a throw is swallowed by
 * `HookBus.fire` as a CLEAN PASS — so "cannot throw" is a policy property here,
 * not a style preference.
 */
export function evaluate(
  rules: readonly PolicyRule[],
  call: { name: string; input: unknown },
): EvaluateResult {
  for (const rule of rules) {
    if (rule.match.tool !== call.name) continue;
    if (!matches(rule.match.when, call.input)) continue;
    return { verdict: rule.verdict, ruleId: rule.id, capability: rule.capability };
  }
  return { verdict: 'allow', ruleId: null, capability: null };
}
