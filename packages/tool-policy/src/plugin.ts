import { makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import {
  createDbEgressAllowlistStore,
  createMemoryEgressAllowlistStore,
  isOwnerId,
  normalizeHost,
  type EgressAllowlistStore,
} from './egress-allowlist.js';
import { evaluate } from './evaluate.js';
import { runToolPolicyMigration, type ToolPolicyDatabase } from './migrations.js';
import { BUILTIN_RULES } from './rules.js';
import {
  EgressRememberOutputSchema,
  EvaluateResultSchema,
  ListCapabilitiesOutputSchema,
  type CapabilityRow,
  type EgressRememberInput,
  type EgressRememberOutput,
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
 * The `tool` half is never copied onto the row — it exists so `capabilityRows`
 * can apply `outOfReach`. See `ListCapabilitiesInput.outOfReach` for why the
 * identifier stays off the row; `fullyDescribedTools` answers the coverage
 * question separately, in a field nothing renders.
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
        // The predicate itself never leaves the plugin — only the fact that
        // there is one. A renderer handed `{ field: 'recursive', equals: true }`
        // would have to turn a tool's argument name into English, and it is the
        // TOOL's vocabulary, not ours. What the reader needs from it is that
        // this row does not apply to every call, and that is a boolean.
        //
        // AN `egress` RULE IS CONDITIONAL TOO (TASK-330), for exactly the same
        // reason a `when` one is: its verdict applies to some calls and not
        // others. Saying "asks you first" flat, about a rule that is silent for
        // every host you already allowed, promises a gate that is not always
        // there — and a reader who believes the gate is always there is the
        // person this row is supposed to protect.
        conditional: rule.match.when !== undefined || rule.egress !== undefined,
        // Left ABSENT rather than set to `undefined` when the rule declares
        // nothing — the same shape `theirDescription` / `mechanicalLabel` use
        // on a built-in row. `exactOptionalPropertyTypes` is on for this
        // package, so `effect: undefined` and "no `effect` key" are two
        // different, type-checked things, and "absent" is the one that means
        // unclassified (see the doc comment on `CapabilityRow.effect`).
        // Unlike `capability`, this value is copied through UNCHANGED: the
        // renderer picks its own words for `outward` / `spends`, so there is
        // nothing here to author, only to carry.
        ...(rule.effect !== undefined && { effect: rule.effect }),
      } satisfies CapabilityRow,
    }));
}

/**
 * Tools some rule describes for EVERY call — see
 * `ListCapabilitiesOutput.fullyDescribedTools`, which carries the reasoning.
 *
 * The filter is the whole point: a tool every one of whose rules carries a
 * `when` predicate is left OUT, because no row then says what happens to the
 * calls those predicates miss. Narrow-plus-broad rules for one tool are the
 * normal shape (`rules.ts` orders them that way), so such a tool is in the list
 * on the strength of its broad rule; a `when`-only tool is the case this
 * distinction exists for.
 *
 * Order follows the table so the answer is stable across calls; the `Set` is
 * for the dedupe that shape implies.
 */
export function fullyDescribedTools(rules: readonly PolicyRule[]): string[] {
  return [
    ...new Set(
      rules.filter((rule) => rule.match.when === undefined).map((rule) => rule.match.tool),
    ),
  ];
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
  /**
   * Hosts the OPERATOR allows every user of this deployment to reach silently
   * through an `egress`-gated tool. Seeded at init, in-process; there is no bus
   * hook that writes a global entry, because minting one is an operator
   * decision and not something a plugin should be able to do on its own.
   *
   * DEFAULT EMPTY, and that is safe only because a miss holds rather than
   * refuses. Do not pre-seed this with something permissive to "make the tool
   * work again" — the tool works, it just asks the first time.
   *
   * A malformed entry is skipped and logged, not fatal: one typo in a
   * deployment's config must not take the host down.
   */
  globalEgressHosts?: readonly string[];
  /** Override the allowlist store. Tests only. */
  egressStore?: EgressAllowlistStore;
}

export function createToolPolicyPlugin(opts?: ToolPolicyPluginOptions): Plugin {
  const rules = opts?.rules ?? BUILTIN_RULES;
  /**
   * Tools some rule gates on the target host. Precomputed so the common case —
   * every other tool in the catalog — never pays for an allowlist read on the
   * `tool:pre-call` path, which runs under a 10 s ceiling the runner turns into
   * a deny.
   */
  const egressTools = new Set(
    rules.filter((r) => r.egress !== undefined).map((r) => r.match.tool),
  );
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

  let egressStore: EgressAllowlistStore = opts?.egressStore ?? createMemoryEgressAllowlistStore();

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'tool-policy:evaluate',
        'tool-policy:list-capabilities',
        'egress-allowlist:remember',
      ],
      // The rule TABLE is still in-repo and still consulted with no I/O. What
      // needs storage is the egress ALLOWLIST (TASK-330) — per-person data a
      // deployment accumulates, which is a different thing from the reviewed
      // rules and is why it is a table rather than a constant.
      calls: [],
      // OPTIONAL, not required, because a deployment without a database is
      // perfectly capable of enforcing this table — it just cannot remember
      // anything, which is the safe direction.
      optionalCalls: [
        {
          hook: 'database:get-instance',
          degradation:
            'The egress allowlist lives only in this process. Operator-seeded ' +
            'global hosts still apply, but a host a person allowed is forgotten ' +
            'on restart and the next page read from it is held again — one extra ' +
            'approval, never a silent grant.',
        },
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      // The store, if this deployment has somewhere to put it. `hasService` and
      // not a try/catch around the call: a MISSING database is a supported
      // configuration with a stated degradation, while a database that is
      // present and broken is a boot failure we want to hear about.
      if (opts?.egressStore === undefined && bus.hasService('database:get-instance')) {
        const { db } = await bus.call<unknown, { db: Kysely<unknown> }>(
          'database:get-instance',
          initCtx,
          {},
        );
        const typed = db as Kysely<ToolPolicyDatabase>;
        await runToolPolicyMigration(typed);
        egressStore = createDbEgressAllowlistStore(typed);
      }

      for (const raw of opts?.globalEgressHosts ?? []) {
        const host = normalizeHost(raw);
        if (host === null) {
          initCtx.logger.warn('tool_policy_global_egress_host_invalid', {
            plugin: PLUGIN_NAME,
            // The VALIDATED-OR-NOTHING rule does not apply to a value that
            // failed validation, and this one comes from the deployment's own
            // config rather than from a model — an operator who mistyped a host
            // cannot fix it if we refuse to say which one.
            host: String(raw).slice(0, 253),
          });
          continue;
        }
        await egressStore.remember({ scope: 'global', ownerId: null, host });
      }

      /**
       * The hosts this caller may reach silently.
       *
       * FAILS CLOSED, and that is the whole reason it is a function with a
       * catch rather than an inline await: every failure mode here — no store,
       * a database blip, an id we would not write under — means "we do not know
       * what this person allowed", and the only safe reading of that is
       * "nothing", which holds. Returning the rule's own verdict is the outcome;
       * an empty set is how we get there without a second code path.
       */
      const allowedHosts = async (ctx: AgentContext): Promise<ReadonlySet<string>> => {
        if (!isOwnerId(ctx.userId)) return new Set<string>();
        try {
          return await egressStore.allowedFor(ctx.userId);
        } catch (err) {
          ctx.logger.error('tool_policy_egress_allowlist_read_failed', {
            plugin: PLUGIN_NAME,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          return new Set<string>();
        }
      };

      bus.registerService<EvaluateInput, EvaluateResult>(
        'tool-policy:evaluate',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Only an `egress`-gated tool pays for the read. Everything else gets
          // the same pure, I/O-free answer it got before this existed.
          const opts2 =
            input?.call !== undefined && egressTools.has(input.call.name)
              ? { allowedHosts: await allowedHosts(ctx) }
              : {};
          return evaluate(rules, input.call, opts2);
        },
        { returns: EvaluateResultSchema },
      );

      /**
       * "This host was just fetched under a verdict that permitted it."
       *
       * The OWNER IS `ctx.userId` AND NOTHING ELSE. There is no owner field on
       * the payload, so no caller can file an entry against somebody else —
       * which is the same privilege escalation the missing `agent` scope exists
       * to prevent, and closing it by shape beats closing it by a check
       * somebody has to remember to write.
       *
       * Never throws for a bad host: `remembered: false` is the answer. A tool
       * call that already succeeded must not fail because a convenience did,
       * and forgetting costs one more approval next time — it grants nothing.
       */
      bus.registerService<EgressRememberInput, EgressRememberOutput>(
        'egress-allowlist:remember',
        PLUGIN_NAME,
        async (ctx, input) => {
          const host = normalizeHost(input?.host);
          if (host === null || !isOwnerId(ctx.userId)) return { remembered: false };
          try {
            return { remembered: await egressStore.remember({ scope: 'user', ownerId: ctx.userId, host }) };
          } catch (err) {
            ctx.logger.warn('tool_policy_egress_remember_failed', {
              plugin: PLUGIN_NAME,
              // Safe to name: it passed `normalizeHost`, so it is a hostname
              // and not the model's URL — no query string, nothing to leak.
              host,
              err: err instanceof Error ? err : new Error(String(err)),
            });
            return { remembered: false };
          }
        },
        { returns: EgressRememberOutputSchema },
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
        //
        // `fullyDescribedTools` is COVERAGE and is not filtered: see its doc
        // on `ListCapabilitiesOutput`. Computed per call rather than hoisted
        // next to `indexed` only because it is a filter over an immutable table
        // of a few dozen rules, and a second frozen module-level cache to keep
        // in step with the first is the kind of thing that drifts.
        async (_ctx, input) => ({
          rows: applyReach(indexed, input?.outOfReach),
          fullyDescribedTools: fullyDescribedTools(rules),
        }),
        { returns: ListCapabilitiesOutputSchema },
      );
    },
  };
}
