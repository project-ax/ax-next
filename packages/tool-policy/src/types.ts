import { z } from 'zod';

export type PolicyVerdict = 'allow' | 'hold' | 'deny';

/**
 * Where a rail row's claim comes from. Named by AW-1 §3.3, which narrowed the
 * design's assumption that every row is a deliberated rule:
 *
 *   - `rule`     — an in-repo policy decision, reviewed in a diff.
 *   - `catalog`  — "this tool is reachable and no rule gates it". A true
 *                  statement about the system, and NOT a reviewed policy
 *                  decision. Rendering it as one would overstate our diligence.
 *   - `grant`    — a durable grant a human made at runtime (AW-14).
 *   - `mcp`      — a mechanical row for a third-party tool (AW-14).
 *   - `unmapped` — reach we cannot describe (design §4.3.5, AW-14).
 *
 * A `PolicyRule` can only carry the first two; the rest exist so the rail's
 * row type is one union rather than three shapes. The renderer switches on
 * this, never on the `source` string — see the boundary review.
 */
export type CapabilityProvenance = 'rule' | 'catalog' | 'grant' | 'mcp' | 'unmapped';

/** The provenance values a `PolicyRule` may declare. */
export type RuleProvenance = Extract<CapabilityProvenance, 'rule' | 'catalog'>;

/**
 * A predicate over the tool call's input. Deliberately tiny and structural:
 * anything richer would need a mini-language, and a mini-language is a thing a
 * human cannot read in a diff. If a rule needs more than this, it needs to be
 * two rules.
 */
export interface PredicateSpec {
  /** Top-level input key. Nested paths are deliberately unsupported. */
  field: string;
  equals: string | number | boolean;
}

/**
 * What the call does in the world, when that is more than reading or writing
 * inside the agent's own sandbox. Declared per rule, because `evaluate()` is
 * given only `{ name, input }` — it cannot see `ToolDescriptor.executesIn`,
 * connector metadata or MCP annotations, so there is nothing to derive this
 * from and the name is the only handle we have.
 *
 *   - `outward` — a third party sees it, or it cannot be taken back: a message
 *     sent, something posted publicly, a payment made. A rule declaring this
 *     MAY NOT be `allow` (enforced by `lintRuleEffect`, wired into the CI
 *     capability gate). This is the case "unguarded by default" would be wrong
 *     for, and the enforcement is what stops it being added as a quiet
 *     one-line `allow`.
 *   - `spends` — costs money per call. `web_search` / `web_extract` bill an
 *     Anthropic Messages call per invocation. This MAY be `allow`; the
 *     requirement is that it is DECLARED, so the spend is in the table rather
 *     than implied by a tool name.
 *
 *     `spends` is a claim about MONEY ONLY. An earlier draft of this comment
 *     also said "no third-party-visible effect", which is false for
 *     `web_extract`: it fetches any public URL the agent names (`url-guard.ts`
 *     refuses only localhost/.local/.internal), so the URL's owner sees the
 *     request and anything encoded in it. Do not read `spends` as "safe" or as
 *     "not outward" — it says nothing about either. See the note on
 *     `web.extract` in rules.ts.
 *
 * The asymmetry is deliberate. Collapsing the two would force a choice between
 * holding every web search (unusable, so the gate gets turned off) and allowing
 * sends and payments by default (indefensible). They are different risks.
 *
 * OMITTED DOES NOT MEAN SAFE — it means nobody has classified this tool. Most
 * rules omit it truthfully (a sandbox read is neither), but an unmatched tool
 * has no rule at all and so no effect either; see `evaluate()`.
 *
 * A RULE DECLARES A SET OF THESE, NOT ONE (TASK-330). The field used to hold a
 * single value, and `web_extract` — which both spends money and hands data to
 * a third party — is exactly the tool that made that a lie: it shipped as
 * `spends` alone, and the outward half went undisclosed because the field had
 * room for only the convenient truth. Declaring both is now expressible, and
 * `lintRuleEffect` reads the set with STRICTEST MEMBER WINS, so an `outward`
 * anywhere in it forces `hold` or `deny` no matter what else is in there.
 *
 * ADDING A MEMBER MEANS ADDING IT IN FOUR PLACES (TASK-408). `channel-web`
 * cannot import this union (invariant 2), so it is hand-copied: here, in
 * `ToolEffectSchema` below, and twice over there as `CapabilityEffect` and the
 * `KNOWN_EFFECTS` allow-list `toWireEffects` filters against — plus authored
 * copy in `EFFECT_DISCLOSURES`.
 *
 * Do the tool-policy half and stop, and `tsc` stays GREEN while the rail DROPS
 * the new member, claiming less reach than the tool has. Measured both ways:
 * widening this union alone compiles clean, and so does widening it together
 * with `ToolEffectSchema` — which is the likelier half-edit, since those two
 * live in this file and the other two do not.
 * `packages/channel-web/src/__tests__/server/effect-mirror-drift.test.ts` is
 * what notices; it reads all four as text.
 */
export type ToolEffect = 'outward' | 'spends';

export interface PolicyRule {
  /** Stable, dotted, printed beside the sentence in the rail as its source. */
  id: string;
  match: { tool: string; when?: PredicateSpec };
  verdict: PolicyVerdict;
  /**
   * Bare infinitive clause, no leading "to", no verdict wording, ≤60 chars.
   * This is a SECURITY CLAIM (design H3): it is generated from the thing that
   * actually enforces it, because it IS on the thing that enforces it. The only
   * way to change what the UI says is to change the rule.
   */
  capability: string;
  subject: 'agent';
  /** See `CapabilityProvenance`. Defaults to `'rule'` when omitted. */
  provenance?: RuleProvenance;
  /**
   * True when the call itself cannot be taken back once it has run, so
   * AW-5/TASK-226 must DEFER it: `@ax/decisions` claims the approval
   * immediately and schedules the replay one undo window later, which is what
   * gives the undo button something left to stop. Omitted means reversible,
   * and a reversible call is replayed at once with no grace period.
   *
   * ON THE HOST PATH ONLY. An ATTENDED decision — one whose agent is still
   * warm — is re-issued by that agent the moment the fingerprint gate lets it
   * through, and nothing host-side can hold it for ten seconds. So an
   * irreversible rule whose calls need the grace period must be raised
   * unattended. That is a recorded limit, not an oversight, recorded in
   * `@ax/decisions`'s own `packages/decisions/src/plugin.ts`.
   *
   * THIS COMMENT USED TO SAY THE OPPOSITE — that AW-5 "must NOT offer the
   * 10-second undo window" on an irreversible call. Corrected against the
   * shipped behaviour in TASK-384: `packages/decisions/src/plugin.ts` sets
   * `deferred = !attended && hasExecutor && current.irreversible`, and only a
   * deferred decision gets a `replayDueAt`. The window exists FOR the
   * irreversible case, not in spite of it.
   *
   * Omitted is the honest default only because every rule seeded today is
   * treated as reversible; a new irreversible rule must set this explicitly.
   * Whether `web.extract` — which declares `outward` and leaves this unset —
   * ought to set it is TASK-409, deliberately still open.
   *
   * Related to but NOT the same as `effect`: `irreversible` is about whether an
   * APPROVAL can be withdrawn during the undo window, `effect` is about what
   * the call does in the world. An `outward` call is usually also
   * irreversible, but a `spends` one is not — you cannot unspend the money,
   * yet there is no outward action to withdraw.
   */
  irreversible?: boolean;
  /**
   * See `ToolEffect`. OMITTED means unclassified, not harmless.
   *
   * An EMPTY ARRAY is not a second spelling of "unclassified" — it is rejected
   * by `lintRuleEffect`, because two ways to say the same thing is how a
   * reader ends up believing they mean different things. Duplicates are
   * rejected for the same reason.
   */
  effect?: ToolEffect[];
  /**
   * EGRESS CONTINGENCY (TASK-330). When set, this rule's `verdict` is the
   * answer for a call whose target host the caller has NOT allowed, and is
   * RELAXED to `allow` for one they have.
   *
   * `urlField` is the top-level input key holding the target URL — the tool's
   * own vocabulary, the same way `PredicateSpec.field` is, and deliberately not
   * a URL matcher: the match is on the parsed HOST and nothing else. A
   * path-or-prefix allowlist would be bypassed by a query string, and a query
   * string is the exfiltration vector this exists to close
   * (`https://allowed.example/?x=<secret>` must not inherit
   * `https://allowed.example`'s permission by looking like it).
   *
   * Kept OFF `match` on purpose. Everything under `match` decides WHETHER a
   * rule applies to a call; this decides what the rule ANSWERS once it does.
   * Folding it into `match` would mean an allowed host fell through to the
   * next rule — and the next rule for a tool is usually nothing at all, which
   * `evaluate` answers `allow` with a null `ruleId`, so the rail would lose the
   * row and the hold would lose its sentence.
   */
  egress?: { urlField: string };
  /**
   * WHO REGISTERS THE TOOL — which is what makes its ABSENCE readable, and the
   * only reason this field exists (TASK-416).
   *
   *   - `'host'`    — a host plugin registers it through `tool:register`, so it
   *                   appears in `tool:list`. A deployment that does not load
   *                   that plugin has no such tool AT ALL, and the catalog
   *                   proves it: absence there is absence, full stop.
   *   - `'sandbox'` — the RUNNER hands it to the agent inside its own
   *                   workspace. It never passes through `tool:register`, so
   *                   the host catalog is silent about it and its absence
   *                   proves NOTHING.
   *
   * THE BUG THIS CLOSES. The rail used to establish "this agent cannot reach
   * that tool" by walking the catalog and keeping what the agent's scope
   * excluded — so it could only ever name tools that were IN the catalog. A
   * rule naming a tool whose plugin never loaded had nothing to be subtracted
   * from and rendered as a live ALLOW, under a heading that promises to
   * describe what is installed today. The TASK-357 walk caught the rail
   * advertising `memory_search` and `web_search` on a deployment that loads
   * neither plugin, with the agent contradicting it in conversation.
   *
   * AND THE MIRROR-IMAGE MISTAKE IT AVOIDS, which is why this is a declaration
   * rather than a catalog check. Reading absence-from-the-catalog as
   * "uninstalled" for EVERY rule would silence the sandbox six — `Bash`,
   * `Read`, `Write`, `Edit`, `Glob`, `Grep` are registered by the runner and
   * are never in the host catalog — and a row that is not there reads as "it
   * cannot do that". That is understating reach on a blast-radius surface,
   * the one direction design H4 forbids, about the largest thing an agent can
   * do. Overstating survives; guessing the sandbox away does not.
   *
   * OMITTED MEANS "NOBODY HAS SAID", and is treated as `'sandbox'` is —
   * nothing is subtracted, which is the overstating direction. The type keeps
   * it optional so a third-party table is not broken by a field it has never
   * heard of; `rules.test.ts` requires every BUILTIN rule to declare it, the
   * same way it requires `provenance`, because a silent default on a claim
   * about whether a capability EXISTS is not a default worth having.
   */
  providedBy?: 'host' | 'sandbox';
}

/**
 * Who an egress-allowlist entry belongs to.
 *
 * This is `@ax/connectors`' `CredentialScope` (`'global' | 'user' | 'agent'`)
 * MINUS the agent tier, and the omission is the security decision, not a
 * simplification to be tidied up later. TASK-257 partitions agent state on
 * `agentId` alone, so a team agent's storage is shared by every teammate who
 * can reach it. An agent-scoped entry would therefore mean one teammate's
 * approval silently granting outbound reach to everyone else using that agent
 * — a privilege escalation behind a UI that looks like a personal decision.
 *
 * `global` (an operator curates it) and `user` (the person who answered the
 * prompt) are the only two scopes where the approver and the beneficiary are
 * the same party.
 */
export type EgressScope = 'global' | 'user';

/** One host somebody has allowed `web_extract`-style egress to. */
export interface EgressAllowlistEntry {
  scope: EgressScope;
  /** `null` exactly when `scope === 'global'`. */
  ownerId: string | null;
  /** Lowercased hostname. Never a URL, never a prefix, never a port. */
  host: string;
}

export interface EvaluateResult {
  verdict: PolicyVerdict;
  ruleId: string | null;
  capability: string | null;
  /**
   * True when the matched rule says approving this call cannot be taken
   * back. `@ax/decisions` (AW-5) captures this ON THE ROW at hold time and
   * defers the replay by the undo window, so the 10-second undo is a real
   * grace period before the outward action rather than a button that cannot
   * undo anything. Absent rule / no match ⇒ false: we only claim
   * irreversibility when a reviewed rule says so.
   */
  irreversible: boolean;
  /**
   * What this call does in the world, for DISCLOSURE only — `effect` gates
   * nothing, `verdict` already decided whether the call happens.
   *
   * REQUIRED, and `[]` is the whole of "the table declares nothing about this
   * call". Two answers, one principle — NEVER ANSWER SILENCE WHERE THE TABLE
   * HAS SPOKEN ABOUT THIS TOOL:
   *
   *   - A RULE MATCHED -> that rule's declared set (`[]` when it declared
   *     none). The rule that answered the verdict is the thing speaking, same
   *     as `ruleId` / `capability` / `irreversible`.
   *   - NO RULE MATCHED -> the UNION, in table order, of the effects declared
   *     by every rule whose `match.tool` is this call's tool.
   *
   * THE UNION IS THE LOAD-BEARING HALF (TASK-383), and without it this field
   * would be `[]` at the one call site it exists to fix. The rail gives a tool
   * a mechanical base row exactly when EVERY rule naming it carries a `when`
   * predicate, and it builds that row by asking us about `input: {}` — the one
   * input no `PredicateSpec` can match, by construction. So for precisely the
   * tools that get a base row, no rule matches and "the matched rule's effect"
   * is empty. A predicate gates the VERDICT, not what the call does in the
   * world: a call that slips past `when: { field: 'url', equals: … }` still
   * spends the money and still hands the URL to its owner. Design H4 forbids
   * understating reach, and the union is the non-understating answer.
   *
   * It is scoped exactly to that gap and cannot leak wider. A tool with an
   * unconditional rule never reaches the union (the unconditional rule always
   * matches); a tool with no rules at all unions nothing. So it cannot mark a
   * benign `Bash` call outward on the strength of a `curl`-predicated sibling —
   * such a tool also has a broad rule, which matches.
   *
   * WHY `irreversible` DOES NOT GET THE SAME TREATMENT, since it is the obvious
   * next question. `irreversible` changes BEHAVIOUR: AW-5 defers the replay of
   * an approval by the undo window. Claiming it off a rule that did not answer
   * would alter approval timing on the strength of a rule that said nothing
   * about this call. `effect` changes nothing. Different risk, different
   * default.
   *
   * NOTE THE CONTRAST WITH `CapabilityRow.effect`, which is ABSENT when
   * unclassified and never present-and-empty. Both spellings are deliberate.
   * That row has no `ruleId`, so absence is the only way it can say "there was
   * never a rule"; here `ruleId: null` already carries that, so `[]` needs no
   * second spelling — and this repo has spent two cards on absent-vs-empty
   * ambiguity in this exact field. Required also means the `returns` schema
   * rejects a non-conforming impl loudly instead of under-disclosing quietly.
   *
   * OMITTED IS NOT EXPRESSIBLE AND EMPTY IS NOT "SAFE": `[]` says nobody
   * classified this call, not that it is harmless. See `ToolEffect`, including
   * the `spends`-is-money-only caveat, which applies here unchanged.
   */
  effect: ToolEffect[];
}

/** One row of "What it may do alone". */
export interface CapabilityRow {
  verdict: PolicyVerdict;
  /** Empty string when `described` is false. */
  capability: string;
  /** Opaque display provenance — `rule:<id>`, `connector:<id>`, `grant:<host>`. */
  source: string;
  /** The machine-readable half of `source`. Switch on THIS, never parse `source`. */
  provenance: CapabilityProvenance;
  /**
   * False for a capability we cannot describe in our own words — an MCP tool,
   * an unmapped grant. The renderer says so out loud rather than omitting the
   * row (design H4: understating reach is worse than overstating it).
   */
  described: boolean;
  /**
   * True when the rule behind this row carries a `when` predicate, so its
   * verdict applies to SOME calls and not others.
   *
   * The renderer needs this because the row is a claim and the two claims are
   * different: "Can delete a folder — asks you first" says every such call
   * stops for you, while a rule predicated on `recursive: true` lets the rest
   * through without stopping for anybody. Framing the second as the first
   * asserts a restriction the table does not enforce, which is the same class
   * of error as asserting reach it does not grant.
   *
   * A row with no rule behind it (mcp, unmapped, grant) is never conditional —
   * there is no predicate to be conditional on.
   */
  conditional: boolean;
  /**
   * The declared `effect` of the rule behind this row, carried onto the row so
   * the rail can DISCLOSE it — see TASK-329. This is NOT a second gate:
   * `verdict` already decides whether the call happens, and `effect` sits
   * beside it as a separate claim about what the call does in the world when
   * it does happen. `web_search` is exactly the case that makes the two
   * independent: `verdict: 'allow'` AND `effect: 'spends'` on the same row,
   * because the money leaves regardless of whether anyone was asked.
   *
   * OMITTED MEANS UNCLASSIFIED, NOT HARMLESS — the same warning `ToolEffect`
   * carries on `PolicyRule`, repeated here because it is easy to read a row
   * with no `effect` key as "this one is fine" rather than "nobody has
   * classified this one". A row with no rule behind it (`mcp`, `unmapped`) has
   * no `effect` for the identical reason it has no `capability`: there was
   * never a rule to declare one, so the honest answer is absent, not `false`
   * or a fabricated default.
   *
   * See `ToolEffect` for the `spends`-is-money-only caveat, which applies here
   * unchanged and is not re-argued in this comment.
   *
   * CARRIED AS THE WHOLE SET, not the first or the worst member (TASK-330). A
   * renderer handed only the strictest one would drop `spends` from
   * `['spends', 'outward']` and stop telling anybody the call costs money;
   * handed only the first it would drop the `outward` disclosure, which is the
   * understating direction design H4 forbids. Absent when the rule declares
   * nothing; never present and empty.
   *
   * DELIBERATELY SPELLED DIFFERENTLY FROM `EvaluateResult.effect`, which is
   * REQUIRED and uses `[]` for "nothing declared" (TASK-383). Not an
   * inconsistency somebody should tidy up: a row carries no `ruleId`, so
   * absence is the only way it can say "there was never a rule to declare
   * one", while an evaluate answer says that with `ruleId: null` and would
   * gain nothing from a second spelling. Read both comments before changing
   * either.
   */
  effect?: ToolEffect[] | undefined;
  /** Only set when `described` is false: the third party's own words, attributed. */
  theirDescription?: string | undefined;
  /** Only set when `described` is false: what we DO control — the tool name. */
  mechanicalLabel?: string | undefined;
}

// ---------------------------------------------------------------------------
// Hook I/O
// ---------------------------------------------------------------------------

export interface EvaluateInput {
  call: { name: string; input: unknown };
  /**
   * Carried but not yet consulted: today the rule table is global. It is in the
   * payload because the DB-backed alternate impl named in the boundary review
   * is per-tenant, and adding the field later would be a breaking change for
   * every caller.
   */
  agentId: string;
}

export interface ListCapabilitiesInput {
  agentId: string;
  /**
   * Tool names the CALLER has established this agent cannot reach.
   *
   * The rule table is global: it describes what the product enforces, not what
   * a particular agent is wired to. An agent scoped to `['Read']` would
   * otherwise be shown "Can search the web — on its own", which is a false
   * ALLOW claim on a blast-radius surface — the one direction design H3/H4
   * says never to be wrong in.
   *
   * The table cannot answer this itself. Which tools exist and which of them an
   * agent can see is the tool catalog's business, and the catalog lives on the
   * other side of the bus. So the caller — which holds both — subtracts, and
   * this plugin applies the subtraction to the rows it owns. `match.tool` never
   * rides out ON A ROW: an identifier on a display row is one a renderer may
   * reach for, and this surface's mechanical rows ARE tool names, so the two
   * would be one typo apart. `fullyDescribedTools` answers the coverage
   * question with the same names in a field nothing renders, which is the
   * distinction that matters — the caller already holds the whole tool
   * catalog.
   *
   * ONLY `allow` AND `hold` ROWS ARE DROPPED. A `deny` for a tool the agent
   * could not reach anyway is still true, and it is reassurance rather than
   * reach — dropping it would understate our restrictions, which costs
   * information and endangers nobody. An `allow` it cannot reach is the lie.
   *
   * Omitted or empty means DROP NOTHING, which is deliberately the overstating
   * direction: a caller that cannot read the catalog gets every row and says
   * elsewhere that its list may be incomplete.
   */
  outOfReach?: string[] | undefined;
}

export interface ListCapabilitiesOutput {
  rows: CapabilityRow[];
  /**
   * Tools this table describes COMPLETELY — every one that has at least one
   * rule with no `when` predicate, so some returned row states what happens to
   * a call the predicates do not catch.
   *
   * COVERAGE, NOT DISPLAY. Nothing renders it. It exists so a caller holding
   * the tool catalog can tell which catalog entries the rows already account
   * for, WITHOUT asking `evaluate` about a call nobody is making. That was
   * TASK-267: the rail evaluated `{ name, input: {} }` and read `ruleId !==
   * null` off the answer, so a rule keyed on a `when` predicate over the
   * arguments never matched, its tool came back "unruled", and the rail put a
   * second, mechanical row beside the described one asserting the
   * unconditional verdict.
   *
   * WHY "FULLY", AND NOT SIMPLY "NAMED". A tool named ONLY by conditional
   * rules is deliberately ABSENT from this list, even though the table plainly
   * names it. Its rows say what happens to the calls the predicates catch and
   * NOTHING says what happens to the rest — which, for an exception table over
   * an allow baseline, is the tool running on its own. A caller that skipped
   * such a tool would render "asks you first, in some cases" and leave the
   * complement unstated, and a reader completes an unstated complement with
   * the safer guess. Understating reach on a blast-radius surface is the one
   * direction design H4 says never to be wrong in, so the caller is told to
   * give that tool a base row of its own.
   *
   * The caller gets that base verdict from `evaluate` with an EMPTY input, and
   * this type is what makes the answer honest rather than fabricated: a
   * `PredicateSpec` matches only an OWN property holding a primitive, so an
   * input with no own properties matches no predicate that exists or could be
   * written. What comes back is therefore precisely the table's fall-through
   * verdict — the answer for every call the predicates miss — which is exactly
   * the reach the base row has to state.
   *
   * Deliberately NOT filtered by `outOfReach`: that filter decides which rows a
   * particular agent may be SHOWN, and this answers what the table covers.
   * A caller doing the scope subtraction has already excluded the out-of-reach
   * tools from its own pass.
   *
   * The values are ax-native tool names out of the in-repo rule table —
   * author-controlled, and the same vocabulary the caller sends back in
   * `outOfReach`. They are kept off the rows and out of the renderer not
   * because they are untrusted but because this surface's MECHANICAL ROWS ARE
   * TOOL NAMES: an identifier sitting on a display row is one a renderer will
   * eventually print, and it would print as a capability nobody authored.
   */
  fullyDescribedTools: string[];
  /**
   * Tools this table names that a HOST PLUGIN registers — see
   * `PolicyRule.providedBy`, which carries the reasoning.
   *
   * COVERAGE, NOT DISPLAY, like `fullyDescribedTools` beside it, and it exists
   * for the half of the reach question this table cannot answer alone. The
   * table says what the product enforces; whether a given deployment LOADED
   * the plugin that provides a tool is the tool catalog's business, and the
   * catalog lives on the other side of the bus. So the caller — which holds
   * both — checks these names against `tool:list` and sends back the misses in
   * `outOfReach`. A name absent from the catalog is a tool this deployment
   * cannot run, and a row claiming it is a false ALLOW (TASK-416).
   *
   * ONLY HOST-PROVIDED NAMES RIDE OUT, and the omission is the safety
   * property. A sandbox built-in is registered by the runner, never appears in
   * `tool:list`, and would therefore be "proved" uninstalled by the very check
   * this field feeds — silencing the six largest capabilities an agent has.
   * A caller cannot make that mistake with a list that never names them.
   *
   * Deliberately NOT filtered by `outOfReach`, for the same reason
   * `fullyDescribedTools` is not: this is a fact about the TABLE, and it is an
   * input to the caller's subtraction rather than an answer shaped by it.
   */
  hostProvidedTools: string[];
}

// ---------------------------------------------------------------------------
// `returns` schemas
//
// A `z.object` STRIPS keys it does not declare (see @ax/core's hook-bus note on
// ToolDescriptor drift), so every optional field has to be declared here or it
// vanishes silently on the way out of the bus.
// ---------------------------------------------------------------------------

/**
 * `egress-allowlist:remember` — "this host was just fetched under a verdict
 * that permitted it; stop asking about it."
 *
 * THE PAYLOAD CARRIES NO OWNER, AND THAT IS THE POINT. The entry is written
 * for `ctx.userId` and nobody else. An `ownerId` field would let any
 * in-process plugin grant silent outbound reach on another person's behalf —
 * the same privilege escalation the missing `agent` tier exists to prevent,
 * just through a different door. Deriving the owner from the context makes
 * "the approver and the beneficiary are the same party" a property of the
 * shape rather than a check somebody has to remember to write.
 *
 * There is no `scope` field either: this hook only ever writes `user`. A
 * `global` entry is an OPERATOR decision and is seeded from the plugin's
 * options at init, in-process, so no bus caller can mint one.
 */
export interface EgressRememberInput {
  /**
   * A hostname — not a URL, not a prefix, no scheme, no port, no path. The
   * caller has already parsed it out of whatever it was fetching; this hook
   * validates the shape again anyway (it is the trust boundary, and the caller
   * got the URL from a model).
   */
  host: string;
}

export interface EgressRememberOutput {
  /**
   * False when the host was rejected as malformed, or when there is nowhere to
   * write it. NOT an error: failing to remember costs a second approval next
   * time, which is the safe direction, and a tool call must never fail because
   * a convenience did.
   */
  remembered: boolean;
}

/**
 * One row of "sites we read without asking", as the hook hands it out.
 *
 * `rememberedAt` is an ISO-8601 instant — NOT a `Date`, and NOT `created_at`.
 * Two reasons, and both of them are the rule rather than a preference. The hook
 * surface is storage- and transport-agnostic (invariant 1), so a column name
 * has no business on it; and a `Date` does not survive JSON, so an IPC hop
 * would hand the renderer a string anyway while every in-process caller saw an
 * object. One shape, the one that crosses the wire unchanged.
 */
export interface EgressAllowlistSite {
  /** Lowercased hostname, exactly as it was stored. */
  host: string;
  /**
   * Which list this entry is on. The reader needs it to know whether the entry
   * is theirs to take back: a `global` one is the operator's, and `revoke`
   * refuses it.
   */
  scope: EgressScope;
  rememberedAt: string;
}

/**
 * `egress-allowlist:list` — "which sites do we read without asking me first?"
 *
 * DELIBERATELY EMPTY, and it is the same decision `EgressRememberInput`
 * documents above. The payload carries no owner and no scope: the answer is
 * assembled for `ctx.userId` — the operator's global entries unioned with that
 * person's own, and never anybody else's.
 *
 * BE PRECISE ABOUT WHAT THE MISSING FIELD BUYS, because an overstated security
 * comment is how a later reader comes to rely on a guarantee that was never
 * there. It does NOT make another person's list unreachable from inside the
 * host: an in-process plugin can call `makeAgentContext({ userId: 'someone' })`
 * and pass that ctx, and host plugins are trusted precisely because they can.
 * What it does buy is two real things. At the NETWORK boundary it is the whole
 * story — the BFF derives `ctx.userId` from the auth cookie and sends no owner,
 * so a browser cannot name one however it shapes the request. And in-process it
 * removes a field every future caller could get wrong by accident, which is a
 * different and more likely failure than a malicious plugin.
 *
 * It is an interface rather than `void` so a later filter (a search box, a
 * cursor) can be added without breaking every caller.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EgressListInput {}

export interface EgressListOutput {
  /** Sorted by host ascending, so a renderer never has to invent an order. */
  sites: EgressAllowlistSite[];
}

/**
 * `egress-allowlist:revoke` — "stop reading this one without asking me."
 *
 * NO OWNER AND NO SCOPE ON THE PAYLOAD, for the reason `EgressListInput` gives
 * — read its note on what that does and does not buy, because it applies here
 * unchanged, only with a DELETE at the end of it instead of a read. The row
 * removed is always (`scope: 'user'`, `ctx.userId`, `host`).
 *
 * The missing `scope` is the stronger of the two, and it is NOT merely a
 * convention: the store's `revoke` takes no scope either, so a caller holding
 * any ctx it likes still cannot phrase a request to delete an operator's
 * global entry. That one survives a forged ctx; the missing `ownerId` does not.
 *
 * A `global` entry is an operator decision and no bus caller can mint one or
 * remove one — `remember` only ever writes `user`, and this only ever deletes
 * `user`. Asking to forget an operator-seeded host is answered
 * `revoked: false`, not honoured and not an error.
 */
export interface EgressRevokeInput {
  /**
   * A hostname — not a URL, not a prefix, no scheme, no port. Validated here
   * again even though the list this came from produced it: it arrives over the
   * bus, and a boundary that trusts its own output is not a boundary.
   */
  host: string;
}

export interface EgressRevokeOutput {
  /**
   * False when the host was malformed, when the caller is not a person, when
   * it belongs to somebody else or to the operator, or when there was simply
   * nothing to delete. NOT an error, and the four cases are deliberately
   * indistinguishable: telling a caller "that host exists but is not yours"
   * would answer a question about another person's list.
   *
   * False also means NOTHING CHANGED, which is the safe direction here in the
   * opposite sense from `remember` — a failed revoke leaves a site allowed, so
   * the UI must show the row still present rather than claim success.
   */
  revoked: boolean;
}

export const PolicyVerdictSchema = z.enum(['allow', 'hold', 'deny']);

/** Mirrors `EgressScope`. See that type for why there is no `agent` member. */
export const EgressScopeSchema = z.enum(['global', 'user']);

export const EgressRememberOutputSchema = z.object({ remembered: z.boolean() });

// Per the block comment above: a `z.object` STRIPS keys it does not declare.
// Drop `scope` from this and the list still renders — every host is there — but
// the reader can no longer tell an operator-curated entry from their own, so
// the UI offers a revoke button that always answers `false`. The bus-level
// tests assert the field is present AFTER the re-parse for exactly that reason.
export const EgressAllowlistSiteSchema = z.object({
  host: z.string(),
  scope: EgressScopeSchema,
  rememberedAt: z.string(),
});

export const EgressListOutputSchema = z.object({
  sites: z.array(EgressAllowlistSiteSchema),
});

export const EgressRevokeOutputSchema = z.object({ revoked: z.boolean() });

export const CapabilityProvenanceSchema = z.enum([
  'rule',
  'catalog',
  'grant',
  'mcp',
  'unmapped',
]);

/**
 * Mirrors `ToolEffect`. See that type for what the two members mean, and for
 * the four-place hand-copy this is one of (TASK-408).
 */
export const ToolEffectSchema = z.enum(['outward', 'spends']);

export const EvaluateResultSchema = z.object({
  verdict: PolicyVerdictSchema,
  ruleId: z.string().nullable(),
  capability: z.string().nullable(),
  irreversible: z.boolean(),
  // Per the block comment above: a `z.object` STRIPS keys it does not declare.
  // Delete this line and `effect` vanishes on the way out of the bus while
  // every unit test on the object `evaluate()` RETURNS (built before the bus
  // re-parse) stays green — the rail then draws no disclosure on a call that
  // spends money or acts outward, which is the understating direction design
  // H4 forbids. `tool-policy.canary.test.ts` runs that mutant deliberately.
  //
  // REQUIRED, matching the interface: a producer that omits it fails the parse
  // loudly instead of under-disclosing quietly.
  effect: z.array(ToolEffectSchema),
});

export const CapabilityRowSchema = z.object({
  verdict: PolicyVerdictSchema,
  capability: z.string(),
  source: z.string(),
  provenance: CapabilityProvenanceSchema,
  described: z.boolean(),
  conditional: z.boolean(),
  // Per the block comment above this block: a `z.object` STRIPS keys it does
  // not declare, so leaving this line out would not fail loudly — it would
  // make `effect` vanish silently on the way out of the bus, and the rail
  // would render no disclosure while every unit test on the row OBJECT (built
  // before the bus re-parse) still passed.
  //
  // `z.array(...)` and not `z.union([enum, array])`: there is one wire shape,
  // and a schema that accepted both would let a producer answer either while
  // every consumer had to handle both forever.
  effect: z.array(ToolEffectSchema).optional(),
  theirDescription: z.string().optional(),
  mechanicalLabel: z.string().optional(),
});

export const ListCapabilitiesOutputSchema = z.object({
  rows: z.array(CapabilityRowSchema),
  // Required, not optional, and that is the safe direction on this surface. An
  // impl that answers without it fails the bus's `returns` parse, and the
  // caller's catch treats the whole read as failed — which shows "we could not
  // read this" rather than silently re-listing every described tool as an
  // undescribed one.
  fullyDescribedTools: z.array(z.string()),
  // Required for the same reason, pointing the other way: an impl that omits
  // this answers "no tool in this table comes from a host plugin", which reads
  // as "nothing here can be proved uninstalled" and restores the false ALLOW
  // of TASK-416. Failing the parse makes the caller say it could not read the
  // rules instead of quietly claiming reach the deployment does not have.
  hostProvidedTools: z.array(z.string()),
});
