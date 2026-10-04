import type { EvaluateResult, PolicyRule, PredicateSpec, ToolEffect } from './types.js';

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
 * Every effect the table declares about a TOOL, in table order, deduped.
 *
 * THE FALL-THROUGH ANSWER FOR `EvaluateResult.effect`, and the reason TASK-383
 * is not a one-line field copy. The rail gives a tool a mechanical base row
 * exactly when EVERY rule naming it carries a `when`, and it builds that row by
 * asking about `input: {}` — the input no `PredicateSpec` can match, by
 * construction. So on the one path this field exists to serve, no rule matches
 * and "the matched rule's effect" is `[]`: we would have shipped a field that
 * is empty precisely where the disclosure was missing.
 *
 * A predicate gates the VERDICT, not what the call does in the world. A call
 * that slips past `when: { field: 'url', equals: … }` still spends the money
 * and still hands the URL to its owner, so answering silence there understates
 * reach, which design H4 forbids.
 *
 * IT CANNOT WIDEN PAST THAT GAP, which is the objection to answer before this
 * looks like guilt by association. A tool with an unconditional rule never
 * reaches here (the unconditional rule always matches); a tool with no rules
 * unions nothing. So a benign `Bash` call cannot be marked outward on the
 * strength of a `curl`-predicated sibling — such a tool also has a broad rule.
 *
 * Dedupe is by value and order is the table's, not sorted: the order a human
 * wrote in `rules.ts` is the order the disclosure reads in, and a set-shaped
 * answer that reordered itself would make the rail's copy drift from the rule
 * for no reason anybody could see in a diff.
 */
function declaredEffectsFor(rules: readonly PolicyRule[], tool: string): ToolEffect[] {
  const union: ToolEffect[] = [];
  for (const rule of rules) {
    if (rule.match.tool !== tool) continue;
    for (const effect of rule.effect ?? []) {
      if (!union.includes(effect)) union.push(effect);
    }
  }
  return union;
}

/**
 * First match wins, so ordering in `rules.ts` is meaningful: narrow rules
 * precede broad ones. No rule matching is `allow` — the rule table is an
 * exception list over a system whose baseline reach is already bounded by the
 * tool catalog, the egress allowlist and the connector scoping (see AW-1).
 *
 * THIS FUNCTION IS THE STATIC LAYER ONLY. A connector-backed tool matches no
 * rule, so the answer HERE is still `allow` — but since TASK-736 that is not
 * the verdict the call gets. `tool-policy:evaluate` (plugin.ts) layers the
 * stored per-tool verdicts on top (`verdicts.ts` `layeredVerdict`): a connector
 * tool nobody set a default for is held ("Ask first"), an admin default is a
 * ceiling, and an agent override can only tighten. That closes the TASK-263
 * hole for connector tools. Since TASK-699 every OTHER MCP-spelled name is
 * held the same way — a non-connector `mcp.<segment>.<tool>` (not a
 * `c<10 hex>` connector namespace; host MCP servers were retired in TASK-792),
 * an unlifted `mcp__<server>__<tool>`, a malformed or over-long `mcp.` key — with
 * a fixed `hold` floor no stored row can loosen (`implicitMcpCeiling`). So for
 * an MCP tool the `allow` returned HERE is never the answer a call gets.
 *
 * WHAT SUCH A TOOL IS ACTUALLY CALLED HERE, because a guard written against the
 * wrong spelling would catch none of them. There used to be two routes; host-
 * side MCP servers (`@ax/mcp-client` re-keying tools as `mcp.${serverId}.${tool}`)
 * were retired in TASK-792, which leaves one, arriving in the dotted `mcp.`
 * keyspace:
 *
 *   - Sandbox-side connector MCP servers: a connector's `mcpServers` run INSIDE
 *     the sandbox, via the per-directory `.mcp.json` the runner writes from
 *     the installed-skill entry (`foldConnectorCaps` in `@ax/chat-orchestrator`
 *     -> `installed-skills.ts` in `@ax/agent-runner-core`). That is the
 *     claude-sdk runner's own MCP client, so the SDK names those tools
 *     `mcp__<server key in .mcp.json>__<tool>`. BEFORE TASK-734 the key was the
 *     connector author's free-text `spec.name`, and the call reached this gate
 *     as `mcp__<spec.name>__<tool>` — passed through verbatim, ambiguous between
 *     connectors that picked the same name, and unmatchable by any `mcp.` rule.
 *     SINCE TASK-734 the host keys each server by an opaque, host-minted
 *     `toolNamespace` (`c` + 10 hex, stable per connector record) and the
 *     claude-sdk runner's `classifySdkToolName` lifts exactly that shape to
 *     `mcp.<toolNamespace>.<tool>`. A foreign `mcp__linear__x` is NOT lifted; it
 *     still arrives verbatim — and is held by the plugin's MCP floor.
 *
 * Either way the canonical form is dotted: gate on `mcp.`, not `mcp__`. (The
 * double-underscore form is the SDK's wire spelling; it is stripped or lifted
 * before a call reaches here.)
 *
 * WHY THE CONNECTOR GATE IS NOT A RULE HERE: `evaluate()` is given only
 * `{ name, input }` — no connector metadata, no MCP annotations — so it cannot
 * tell an outward tool from a read by name. The per-tool verdict store is
 * where that knowledge lives (an admin chooses per tool, pre-filled from the
 * server's hints), and the plugin consults it.
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
      // The matched rule's own set, `[]` when it declared none — same source as
      // `ruleId` / `capability`, because the rule that answered the verdict is
      // the thing speaking. Note the relaxation above does NOT clear this: an
      // allowed host changes whether we ask, not whether the fetch costs money
      // or reaches a third party.
      //
      // COPIED, not handed out by reference. `rules` is a module-level constant
      // shared by every later call and `readonly` only in the type system, so a
      // caller that sorted or appended to this array would silently rewrite a
      // security claim for everybody after it — and `evaluate` would have
      // stopped being pure in the one way nothing here would notice.
      effect: rule.effect === undefined ? [] : [...rule.effect],
    };
  }
  // NO RULE SPOKE TO THE VERDICT — `ruleId: null` says so and we do not pretend
  // otherwise. `effect` is the one field that reads wider than the match: see
  // `declaredEffectsFor` for why silence here would be the understating answer,
  // and why `irreversible` deliberately does NOT get the same treatment (it
  // changes approval timing; this changes only what we disclose).
  return {
    verdict: 'allow',
    ruleId: null,
    capability: null,
    irreversible: false,
    effect: declaredEffectsFor(rules, call.name),
  };
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
