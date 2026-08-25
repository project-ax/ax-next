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
 * THE KNOWN HOLE IN THAT DEFAULT (TASK-263). A connector-backed tool matches no
 * rule and is therefore allowed. Wire up a Gmail-style connector at runtime and
 * `send_message` is unguarded — an outward call, allowed, with no human having
 * reviewed that specific claim. The rail does show it (as
 * `provenance: 'mcp'|'unmapped'`, `described: false`), so it is visible rather
 * than hidden; it is simply not gated.
 *
 * WHAT SUCH A TOOL IS ACTUALLY CALLED HERE, because a guard written against the
 * wrong spelling would catch none of them: `@ax/mcp-client` re-keys every
 * MCP-sourced tool as `mcp.${serverId}.${tool}` — DOT-separated — and registers
 * it as a host tool. Host tools are multiplexed through our own
 * `ax-host-tools` server, so the SDK sees `mcp__ax-host-tools__mcp.<id>.<tool>`
 * and `classifySdkToolName` strips that wrapper, leaving `mcp.<id>.<tool>`. On
 * the aisdk runner there is no `mcp__` prefix at all. So the double-underscore
 * form belongs to OUR two in-process servers and is already stripped; a real
 * connector tool never wears it. Gate on `mcp.`, not `mcp__`.
 *
 * WHY IT IS STILL `allow`. Two separate obstacles, worth not conflating:
 *
 *   1. `evaluate()` is given only `{ name, input }` — no `ToolDescriptor`, no
 *      connector metadata, no MCP annotations. It cannot tell an outward tool
 *      from a read by name, so "hold the outward ones" is not expressible here
 *      at all. This is the blocker for a targeted fix.
 *   2. Holding ALL unmatched tools instead is expressible, and its cost is
 *      friction rather than impossibility: approval is per call (`takeApproval`
 *      consumes one authorisation, keyed on a fingerprint of `{name,input}`),
 *      so a human CAN say yes — just never once-and-for-all. On a
 *      high-frequency READ connector that is a prompt per call, which ends with
 *      the operator turning the gate off. A durable per-tool grant (TASK-328)
 *      is what would make it bearable.
 *
 * Note (2) is a friction argument about read connectors and does NOT justify
 * leaving outward connectors ungated — for those, a prompt per call is the
 * correct UX and needs no new mechanism. It is (1) that blocks doing it
 * properly. Meanwhile `effect: 'outward'` + `lintRuleEffect` stop a *known*
 * outward tool being added to the table as a quiet `allow`.
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
