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
 * THE KNOWN HOLE IN THAT DEFAULT (TASK-263). Only our two in-process MCP
 * servers get their prefix stripped upstream, so a third-party or
 * connector-backed tool arrives here as the full `mcp__<server>__<tool>`
 * string, matches nothing, and is allowed. Wire up a Gmail-style connector at
 * runtime and `send_message` is unguarded — an outward call, allowed, with no
 * human having reviewed that specific claim. The rail does show it (as
 * `provenance: 'mcp'|'unmapped'`, `described: false`), so it is visible rather
 * than hidden; it is simply not gated.
 *
 * This is NOT fixed by flipping the default to `hold`, which is why it is still
 * `allow` here. There is no durable per-tool "always allow": `@ax/host-grants`
 * grants egress HOSTS, and `DecisionStatus` is per-decision, so nothing carries
 * a yes forward to the next call of the same tool. Holding unmatched tools
 * would therefore hold EVERY connector call forever, which ends with the
 * operator turning the gate off — strictly worse than the status quo. Closing
 * this needs that grant mechanism first; `effect: 'outward'` and
 * `lintRuleEffect` meanwhile stop a *known* outward tool being added to the
 * table as a quiet `allow`.
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
    return {
      verdict: rule.verdict,
      ruleId: rule.id,
      capability: rule.capability,
      irreversible: rule.irreversible === true,
    };
  }
  return { verdict: 'allow', ruleId: null, capability: null, irreversible: false };
}
