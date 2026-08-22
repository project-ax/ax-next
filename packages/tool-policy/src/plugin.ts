import type { Plugin } from '@ax/core';
import { evaluate } from './evaluate.js';
import { BUILTIN_RULES } from './rules.js';
import {
  EvaluateResultSchema,
  ListCapabilitiesOutputSchema,
  type CapabilityRow,
  type EvaluateInput,
  type EvaluateResult,
  type ListCapabilitiesInput,
  type ListCapabilitiesOutput,
  type PolicyRule,
  type PolicyVerdict,
} from './types.js';

const PLUGIN_NAME = '@ax/tool-policy';

/**
 * Design §4.3.2: allow first, then hold, then deny. The allows are the risky
 * facts and get top billing; the denies are reassurance and belong at the
 * bottom.
 */
const VERDICT_ORDER: readonly PolicyVerdict[] = ['allow', 'hold', 'deny'];

/**
 * Rule table → rail rows, paired with the tool each row came from.
 *
 * Stable within a verdict group: rules.ts order is authored order, and
 * re-sorting inside a group would make the rail's reading order an accident of
 * the sort algorithm.
 *
 * The `tool` half never leaves this module — it exists so `capabilityRows` can
 * apply `outOfReach`. See `ListCapabilitiesInput.outOfReach` for why the
 * identifier stays in here rather than riding out on the row.
 */
interface IndexedRow {
  row: CapabilityRow;
  tool: string;
  /** True when this row asserts REACH. A `deny` asserts the absence of it. */
  assertsReach: boolean;
}

function indexRules(rules: readonly PolicyRule[]): IndexedRow[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const d =
        VERDICT_ORDER.indexOf(a.rule.verdict) - VERDICT_ORDER.indexOf(b.rule.verdict);
      return d !== 0 ? d : a.index - b.index;
    })
    .map(({ rule }) => ({
      tool: rule.match.tool,
      assertsReach: rule.verdict !== 'deny',
      row: {
        verdict: rule.verdict,
        capability: rule.capability,
        source: `rule:${rule.id}`,
        provenance: rule.provenance ?? 'rule',
        // Always true for a built-in rule: `capability` is authored in-repo and
        // CI-linted, so it IS our claim. A row we cannot describe in our own
        // words (an MCP tool, an unmapped grant) is `described: false`, and this
        // plugin never produces one — see the PR's security note.
        described: true,
      } satisfies CapabilityRow,
    }));
}

export interface CapabilityRowsOptions {
  /** See `ListCapabilitiesInput.outOfReach`. */
  outOfReach?: readonly string[] | undefined;
}

/**
 * Rule table → rail rows, minus any REACH claim the caller has established this
 * agent cannot make.
 */
export function capabilityRows(
  rules: readonly PolicyRule[],
  opts: CapabilityRowsOptions = {},
): CapabilityRow[] {
  return applyReach(indexRules(rules), opts.outOfReach);
}

function applyReach(
  indexed: readonly IndexedRow[],
  outOfReach: readonly string[] | undefined,
): CapabilityRow[] {
  if (outOfReach === undefined || outOfReach.length === 0) {
    return indexed.map((r) => r.row);
  }
  const unreachable = new Set(outOfReach);
  return indexed
    .filter((r) => !(r.assertsReach && unreachable.has(r.tool)))
    .map((r) => r.row);
}

export interface ToolPolicyPluginOptions {
  /** Override the rule table. Tests only — production uses BUILTIN_RULES. */
  rules?: readonly PolicyRule[];
}

export function createToolPolicyPlugin(opts?: ToolPolicyPluginOptions): Plugin {
  const rules = opts?.rules ?? BUILTIN_RULES;
  // Indexed once: the table is immutable for the process's lifetime, and the
  // rail asks for it on every render of the workspace shell. Only the per-call
  // `outOfReach` subtraction runs per request, and that is a Set lookup.
  //
  // Frozen because these rows carry a SECURITY CLAIM and are shared across
  // every caller. The bus's `returns` zod re-parse already hands each caller a
  // fresh object, so this is belt-and-braces against a future in-process
  // consumer editing a sentence in place and silently changing what every
  // later reader is told the agent may do.
  const indexed = indexRules(rules).map((r) => ({ ...r, row: Object.freeze(r.row) }));
  Object.freeze(indexed);

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool-policy:evaluate', 'tool-policy:list-capabilities'],
      // No runtime dependencies at all: the rule table is in-repo, there is no
      // database, and nothing is consulted per call. `host-grants:list-for-user`
      // will supply the "Granted by you" group (§4.3.4) — that is AW-14's
      // reader, in channel-web, not this plugin's call.
      calls: [],
      subscribes: [],
    },

    async init({ bus }) {
      bus.registerService<EvaluateInput, EvaluateResult>(
        'tool-policy:evaluate',
        PLUGIN_NAME,
        async (_ctx, input) => evaluate(rules, input.call),
        { returns: EvaluateResultSchema },
      );

      bus.registerService<ListCapabilitiesInput, ListCapabilitiesOutput>(
        'tool-policy:list-capabilities',
        PLUGIN_NAME,
        // The rule TABLE is global today, so `agentId` does not change the
        // answer. It is in the payload because the per-tenant alternate impl
        // (see the boundary review) needs it and adding it later would break
        // every caller.
        //
        // The ROWS are not global, and that is the point of `outOfReach`: the
        // table says what the product enforces, an agent's wiring says what it
        // can reach, and a rail that showed the first as the second would
        // assert reach the agent does not have.
        async (_ctx, input) => ({ rows: applyReach(indexed, input?.outOfReach) }),
        { returns: ListCapabilitiesOutputSchema },
      );
    },
  };
}
