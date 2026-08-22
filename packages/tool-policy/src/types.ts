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
   * True when approving this call cannot be taken back, so AW-5/TASK-226 must
   * NOT offer the 10-second undo window on it. Omitted means reversible —
   * which is the honest default only because every rule seeded today IS
   * reversible; a new irreversible rule must set this explicitly.
   */
  irreversible?: boolean;
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
   * leaves the plugin: exposing it would put an identifier on a display row
   * that a renderer must not render, which is a foot-gun on this surface.
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
}

// ---------------------------------------------------------------------------
// `returns` schemas
//
// A `z.object` STRIPS keys it does not declare (see @ax/core's hook-bus note on
// ToolDescriptor drift), so every optional field has to be declared here or it
// vanishes silently on the way out of the bus.
// ---------------------------------------------------------------------------

export const PolicyVerdictSchema = z.enum(['allow', 'hold', 'deny']);

export const CapabilityProvenanceSchema = z.enum([
  'rule',
  'catalog',
  'grant',
  'mcp',
  'unmapped',
]);

export const EvaluateResultSchema = z.object({
  verdict: PolicyVerdictSchema,
  ruleId: z.string().nullable(),
  capability: z.string().nullable(),
  irreversible: z.boolean(),
});

export const CapabilityRowSchema = z.object({
  verdict: PolicyVerdictSchema,
  capability: z.string(),
  source: z.string(),
  provenance: CapabilityProvenanceSchema,
  described: z.boolean(),
  theirDescription: z.string().optional(),
  mechanicalLabel: z.string().optional(),
});

export const ListCapabilitiesOutputSchema = z.object({
  rows: z.array(CapabilityRowSchema),
});
