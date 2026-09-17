import type { EvaluateResult, PolicyRule, PredicateSpec } from './types.js';

/**
 * The target host of an egress-gated call, or `null` when there isn't one we
 * are willing to name.
 *
 * TOTAL BY CONSTRUCTION — `new URL` throws on anything it dislikes and this is
 * called from a function that must not throw. Every `null` return means "we
 * could not establish the host", and every caller treats that as NOT ALLOWED,
 * so an input we cannot parse holds rather than sliding through.
 *
 * Own-property and primitive checks mirror `matches()` below, for the same
 * reason: without them a call whose input is `{}` would read `url` off
 * `Object.prototype` on some future shape, and a non-string would stringify
 * into something that parses.
 */
function egressHost(input: unknown, urlField: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  if (!Object.prototype.hasOwnProperty.call(input, urlField)) return null;
  const raw = (input as Record<string, unknown>)[urlField];
  if (typeof raw !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // `URL.hostname` keeps IPv6 literals in brackets and has already applied
  // IDNA, so a unicode homograph arrives here in its punycode form and cannot
  // collide with the ASCII host somebody allowed. Lowercased anyway: `hostname`
  // already is, and relying on that for a security comparison is the kind of
  // assumption that quietly stops being true.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host.length > 0 ? host : null;
}

export interface EvaluateOptions {
  /**
   * Hosts the CALLER has established this person may reach without being asked
   * — the union of the operator's global entries and their own remembered ones,
   * resolved before we got here because this function does no I/O.
   *
   * OMITTED MEANS NONE, which is the fail-closed direction and is relied upon:
   * the plugin passes an empty set when the allowlist read fails, so "we do not
   * know what is allowed" and "nothing is allowed" produce the same hold.
   */
  allowedHosts?: ReadonlySet<string> | undefined;
}

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
  opts: EvaluateOptions = {},
): EvaluateResult {
  for (const rule of rules) {
    if (rule.match.tool !== call.name) continue;
    if (!matches(rule.match.when, call.input)) continue;
    return {
      // THE EGRESS RELAXATION (TASK-330), and it is a relaxation of the VERDICT
      // alone: `ruleId`, `capability` and `irreversible` still come from the
      // rule that matched, because the rule is still the thing speaking. A
      // silent allow that reported `ruleId: null` would look to the rail like a
      // tool nothing describes.
      //
      // Reached ONLY by a rule that opted in with `egress`. Every other rule
      // answers exactly what it answered before this existed, so the allowlist
      // can never turn some unrelated `hold` into an `allow` by accident.
      verdict: egressAllows(rule, call.input, opts.allowedHosts)
        ? 'allow'
        : rule.verdict,
      ruleId: rule.id,
      capability: rule.capability,
      irreversible: rule.irreversible === true,
    };
  }
  return { verdict: 'allow', ruleId: null, capability: null, irreversible: false };
}

/**
 * EXACT host equality, and nothing else.
 *
 * Not a prefix (`https://allowed.example/` must not cover
 * `https://allowed.example.evil.test/`), not a path (a path allowlist is
 * bypassed by a query string, and the query string is the exfiltration
 * vector), not a suffix (allowing `example.com` must not silently allow every
 * subdomain somebody can register under it).
 */
function egressAllows(
  rule: PolicyRule,
  input: unknown,
  allowedHosts: ReadonlySet<string> | undefined,
): boolean {
  if (rule.egress === undefined) return false;
  if (allowedHosts === undefined || allowedHosts.size === 0) return false;
  const host = egressHost(input, rule.egress.urlField);
  return host !== null && allowedHosts.has(host);
}
