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
  createDbVerdictStore,
  createMemoryVerdictStore,
  type StoredOverride,
  type VerdictStore,
} from './verdict-store.js';
import {
  ceilingFor,
  consultsVerdictStore,
  isLooserThan,
  isOverridableKey,
  isPolicyVerdict,
  layeredVerdict,
  parseConnectorToolKey,
  strictest,
  CONNECTOR_TOOL_NAMESPACE_RE,
} from './verdicts.js';
import {
  EgressListOutputSchema,
  EgressRememberOutputSchema,
  EgressRevokeOutputSchema,
  EvaluateResultSchema,
  GetConnectorDefaultsOutputSchema,
  ListAgentOverridesOutputSchema,
  ListCapabilitiesOutputSchema,
  SetAgentOverrideOutputSchema,
  SetConnectorDefaultsOutputSchema,
  SnapshotConnectorForAgentOutputSchema,
  type CapabilityRow,
  type EgressListInput,
  type EgressListOutput,
  type EgressRememberInput,
  type EgressRememberOutput,
  type EgressRevokeInput,
  type EgressRevokeOutput,
  type EvaluateInput,
  type EvaluateResult,
  type GetConnectorDefaultsInput,
  type GetConnectorDefaultsOutput,
  type ListAgentOverridesInput,
  type ListAgentOverridesOutput,
  type ListCapabilitiesInput,
  type ListCapabilitiesOutput,
  type PolicyRule,
  type PolicyVerdict,
  type SetAgentOverrideInput,
  type SetAgentOverrideOutput,
  type SetConnectorDefaultsInput,
  type SetConnectorDefaultsOutput,
  type SnapshotConnectorForAgentInput,
  type SnapshotConnectorForAgentOutput,
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

/**
 * Tools some rule names that a HOST PLUGIN registers — see
 * `ListCapabilitiesOutput.hostProvidedTools` and `PolicyRule.providedBy`.
 *
 * `=== 'host'` and not `!== 'sandbox'`: a rule that declares nothing is one
 * nobody has classified, and the only safe reading of "nobody has said" is the
 * one that subtracts nothing. Inverting the test would quietly enroll every
 * undeclared rule in a check that can DROP its row.
 *
 * Order follows the table so the answer is stable across calls; the `Set` is
 * for the dedupe two rules over one tool imply.
 */
export function hostProvidedTools(rules: readonly PolicyRule[]): string[] {
  return [
    ...new Set(
      rules.filter((rule) => rule.providedBy === 'host').map((rule) => rule.match.tool),
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
  /** Override the per-tool verdict store. Tests only. */
  verdictStore?: VerdictStore;
  /**
   * How long a cached read of an agent's overrides / a connector's defaults is
   * trusted. Writes through THIS process invalidate immediately; the TTL bounds
   * how stale another host replica's write can look here. Tests only.
   */
  verdictCacheTtlMs?: number;
  /** Clock for the cache. Tests only. */
  now?: () => number;
}

/** See `ToolPolicyPluginOptions.verdictCacheTtlMs`. */
const DEFAULT_VERDICT_CACHE_TTL_MS = 30_000;
/** One write hook call may name at most this many tools. */
const MAX_VERDICTS_PER_WRITE = 500;
const MAX_NAMESPACES_PER_CALL = 32;
const MAX_ID_CHARS = 256;

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS;
}

/** A list of host-minted connector namespaces, or `null` when any entry is not one. */
function namespaceList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_NAMESPACES_PER_CALL) return null;
  const out: string[] = [];
  for (const ns of v) {
    if (typeof ns !== 'string' || !CONNECTOR_TOOL_NAMESPACE_RE.test(ns)) return null;
    if (!out.includes(ns)) out.push(ns);
  }
  return out;
}

interface Cached<T> {
  at: number;
  value: T;
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
  let verdictStore: VerdictStore = opts?.verdictStore ?? createMemoryVerdictStore();
  const cacheTtlMs = opts?.verdictCacheTtlMs ?? DEFAULT_VERDICT_CACHE_TTL_MS;
  const clock = opts?.now ?? Date.now;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'tool-policy:evaluate',
        'tool-policy:list-capabilities',
        'egress-allowlist:remember',
        'egress-allowlist:list',
        'egress-allowlist:revoke',
        'tool-policy:set-connector-defaults',
        'tool-policy:get-connector-defaults',
        'tool-policy:set-agent-override',
        'tool-policy:list-agent-overrides',
        'tool-policy:snapshot-connector-for-agent',
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
            'approval, never a silent grant. Per-tool verdicts (connector ' +
            'defaults, agent overrides) are likewise in-process only: after a ' +
            'restart connector tools fall back to Ask first and abilities to ' +
            'their static rule.',
        },
      ],
      // Purges (TASK-736): an agent's overrides go with the agent; a
      // connector's defaults — and every agent's overrides for its tools — go
      // with the connector. TASK-752: when a connector's MCP server is renamed
      // its namespace changes, so the rows move with it (or, for a removed
      // server, go) instead of being orphaned under the old one.
      subscribes: ['agents:deleted', 'connectors:deleted', 'connectors:tool-namespaces-changed'],
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
      if (
        (opts?.egressStore === undefined || opts?.verdictStore === undefined) &&
        bus.hasService('database:get-instance')
      ) {
        const { db } = await bus.call<unknown, { db: Kysely<unknown> }>(
          'database:get-instance',
          initCtx,
          {},
        );
        const typed = db as Kysely<ToolPolicyDatabase>;
        await runToolPolicyMigration(typed);
        if (opts?.egressStore === undefined) egressStore = createDbEgressAllowlistStore(typed);
        if (opts?.verdictStore === undefined) verdictStore = createDbVerdictStore(typed);
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
       * catch rather than an inline await: every failure here — no store, a
       * database blip, a schema that has not migrated — means "we do not know
       * what is allowed", and the only safe reading of that is "nothing", which
       * holds. Returning the rule's own verdict is the outcome; an empty set is
       * how we get there without a second code path.
       *
       * An id that names no person is NOT one of those failures. It answers the
       * operator's global list and nothing personal — see the store, and the
       * note below.
       */
      const allowedHosts = async (ctx: AgentContext): Promise<ReadonlySet<string>> => {
        // NO SHORT-CIRCUIT ON A NON-PERSON CALLER, deliberately, and it used to
        // be here. `allowedFor` already drops the personal half of its read for
        // an id it would never have written under, so the guard was redundant —
        // and worse than redundant: it also threw away the OPERATOR's global
        // list, which is not a claim about a person at all. One place owns the
        // rule about which ids are real (`isOwnerId`, inside the store), and
        // this is not a second one.
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

      // -------------------------------------------------------------------
      // Per-tool verdicts (TASK-736): cached reads.
      //
      // Per-agent overrides and per-namespace connector defaults, each cached
      // for `cacheTtlMs` and DROPPED on every write or purge that goes through
      // this process. The `tool:pre-call` path runs under a 10 s ceiling the
      // runner turns into a deny, and a connector-heavy turn makes many calls;
      // one indexed read per agent per TTL is what keeps that cheap.
      //
      // The TTL is the honest bound on cross-replica staleness: a write landed
      // through ANOTHER host process is invisible here until the entry ages
      // out. A tightened ceiling can therefore lag by up to the TTL on a
      // multi-replica host — stated, not hidden.
      // -------------------------------------------------------------------
      const overrideCache = new Map<string, Cached<Map<string, StoredOverride>>>();
      const defaultsCache = new Map<string, Cached<Map<string, PolicyVerdict>>>();
      const fresh = <T,>(c: Cached<T> | undefined): c is Cached<T> =>
        c !== undefined && clock() - c.at < cacheTtlMs;

      const overridesFor = async (agentId: string): Promise<Map<string, StoredOverride>> => {
        const hit = overrideCache.get(agentId);
        if (fresh(hit)) return hit.value;
        const rows = await verdictStore.overridesFor(agentId);
        const value = new Map(rows.map((r) => [r.toolKey, r] as const));
        overrideCache.set(agentId, { at: clock(), value });
        return value;
      };

      const defaultsFor = async (
        toolNamespaces: readonly string[],
      ): Promise<Map<string, PolicyVerdict>> => {
        const out = new Map<string, PolicyVerdict>();
        const missing: string[] = [];
        for (const ns of toolNamespaces) {
          const hit = defaultsCache.get(ns);
          if (fresh(hit)) for (const [k, v] of hit.value) out.set(k, v);
          else missing.push(ns);
        }
        if (missing.length > 0) {
          const read = await verdictStore.connectorDefaultsFor(missing);
          const at = clock();
          for (const ns of missing) {
            const prefix = `mcp.${ns}.`;
            const value = new Map([...read].filter(([k]) => k.startsWith(prefix)));
            defaultsCache.set(ns, { at, value });
            for (const [k, v] of value) out.set(k, v);
          }
        }
        return out;
      };

      /** Namespaces of the connector tool keys in `keys`, deduped. */
      const namespacesOf = (keys: Iterable<string>): string[] => {
        const out = new Set<string>();
        for (const k of keys) {
          const parsed = parseConnectorToolKey(k);
          if (parsed !== null) out.add(parsed.toolNamespace);
        }
        return [...out];
      };

      /**
       * The layered verdict for a call the static table has already answered.
       *
       * FAILS CLOSED TO `hold` — never to the static answer, which for an
       * `mcp.*` tool is `allow`. A store we cannot read means "we do not know
       * whether this person turned it off or an admin set it to Ask", and the
       * only reading of that which cannot grant something somebody withheld is
       * to ask. `strictest` keeps a static `deny` a deny.
       *
       * An unusable `agentId` is the same failure: without it we cannot read
       * the agent's own denies, and reading none would be the loosening one.
       */
      const layered = async (
        ctx: AgentContext,
        agentId: unknown,
        toolName: string,
        staticVerdict: PolicyVerdict,
      ): Promise<PolicyVerdict> => {
        try {
          if (!isId(agentId)) throw new Error('evaluate payload has no usable agentId');
          const override = (await overridesFor(agentId)).get(toolName)?.verdict;
          const conn = parseConnectorToolKey(toolName);
          const connectorDefault =
            conn === null ? undefined : (await defaultsFor([conn.toolNamespace])).get(toolName);
          return layeredVerdict({ toolName, staticVerdict, connectorDefault, override });
        } catch (err) {
          ctx.logger.error('tool_policy_verdict_store_read_failed', {
            plugin: PLUGIN_NAME,
            tool: toolName,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          return strictest(staticVerdict, 'hold');
        }
      };

      bus.registerService<EvaluateInput, EvaluateResult>(
        'tool-policy:evaluate',
        PLUGIN_NAME,
        async (ctx, input) => {
          // A PAYLOAD WE CANNOT READ IS A DENY, NOT A THROW.
          //
          // `evaluate` reads `call.name`, so a missing `call` would raise a
          // TypeError here — and this runs inside `@ax/decisions`' `tool:pre-call`
          // subscriber, where `HookBus.fire` catches a subscriber's throw and
          // CONTINUES. A throw on this path is therefore a SILENT ALLOW, which is
          // the worst outcome the gate has. Unreachable through the one caller
          // today, which always sends a well-formed call; guarded anyway, because
          // the cost of being wrong is asymmetric and the guard is three lines.
          //
          // `deny` rather than `hold`: a hold invites a human to say yes to a
          // call we could not describe, and `decisions` deliberately routes an
          // unrecognised verdict down the deny branch for the same reason.
          const call = input?.call;
          if (typeof call?.name !== 'string' || call.name.length === 0) {
            ctx.logger.warn('tool_policy_evaluate_malformed_call', { plugin: PLUGIN_NAME });
            // `effect: []` is REQUIRED here (TASK-383), and it is not
            // decoration. The field is required on `EvaluateResult`, so
            // omitting it fails the bus's `returns` parse and this careful deny
            // becomes a THROW at the call site instead. Traced, because the
            // consequence differs per caller and only one of them is safe:
            // `@ax/decisions` wraps the call in a fail-closed catch and would
            // still refuse, but with the generic gate-failure sentence rather
            // than this deliberated one; the rail catches per tool and loses
            // the ROW, which understates reach — the direction design H4
            // forbids. Neither is a silent allow, and neither is what we meant.
            //
            // `[]` is also the honest value: we could not read a tool name, so
            // there is nothing to union and nothing the table has said about
            // this call.
            return {
              verdict: 'deny',
              ruleId: null,
              capability: null,
              irreversible: false,
              effect: [],
            };
          }
          // Only an `egress`-gated tool pays for the read. Everything else gets
          // the same pure, I/O-free answer it got before this existed.
          const opts2 = egressTools.has(call.name)
            ? { allowedHosts: await allowedHosts(ctx) }
            : {};
          const base = evaluate(rules, call, opts2);
          // Only an overridable tool (an ability or `mcp.*`) pays for the
          // verdict-store read; every other tool's answer is the table's.
          if (!consultsVerdictStore(call.name)) return base;
          const verdict = await layered(ctx, input?.agentId, call.name, base.verdict);
          // `ruleId` / `capability` / `effect` stay the table's: a stored
          // verdict changes whether we ask, not what the call does or which
          // rule describes it.
          return verdict === base.verdict ? base : { ...base, verdict };
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

      /**
       * "Which sites do we read without asking me first?"
       *
       * The counterpart to `remember`, and the half TASK-330 shipped without:
       * a list somebody can accumulate but never see is one they cannot audit
       * and cannot take back.
       *
       * THE OWNER IS `ctx.userId`, same as the write. No owner field on the
       * payload, so a caller has to hold a ctx for the person whose list it
       * wants — which is the whole guarantee at the network boundary (the BFF
       * mints that ctx from the auth cookie) and a smaller one in-process,
       * where a trusted plugin could forge the ctx anyway. See
       * `EgressListInput` for the honest version of that claim. The store also
       * drops the personal half of its read for an id that names nobody, so a
       * `system` context sees the operator's list and nothing else.
       *
       * FAILS SOFT BUT NOT SILENTLY (TASK-464). It still does not throw — the
       * reasoning for that survives: a read failure GRANTS NOTHING, because the
       * enforcement path has its own read and its own fail-closed catch, and a
       * throw at a UI caller turns a degraded panel into a broken one.
       *
       * WHAT CHANGED IS THE VALUE. This used to answer `{ sites: [] }` on a
       * store throw, and `[]` is the same answer a person with nothing
       * remembered gets. So the one surface whose job is to say what somebody
       * has agreed to told them, confidently, that the answer was "nothing",
       * over a read that never reached the table. That is failing toward
       * REASSURANCE, which is the wrong direction for a list of grants — an
       * allowlist that reads as empty when it is merely unreadable invites the
       * conclusion that there is nothing to revoke.
       *
       * It was not only a UI problem: the Postgres canary asserted
       * `sites === []` to prove a revoke had landed, and mutant M13 (TASK-469)
       * made `listFor` throw, got swallowed here, and passed the assertion over
       * a read that never happened. `status: 'unknown'` is a value neither the
       * success path nor a vacuous test can produce by accident.
       */
      bus.registerService<EgressListInput, EgressListOutput>(
        'egress-allowlist:list',
        PLUGIN_NAME,
        async (ctx) => {
          try {
            return { status: 'ok', sites: await egressStore.listFor(ctx.userId) };
          } catch (err) {
            ctx.logger.error('tool_policy_egress_allowlist_list_failed', {
              plugin: PLUGIN_NAME,
              err: err instanceof Error ? err : new Error(String(err)),
            });
            // The REASON stays here and goes no further. A caller gets "we do
            // not know", which is all it can act on; an operator gets the
            // exception, which is what they can act on.
            return { status: 'unknown' };
          }
        },
        { returns: EgressListOutputSchema },
      );

      /**
       * "Stop reading this one without asking me."
       *
       * DELETES ONE ROW AND ONLY EVER A `user` ONE — the store hard-codes the
       * scope, so this hook has no way to ask for an operator's global entry
       * even if a caller sent `scope: 'global'` in the payload. The owner is
       * `ctx.userId` for the same reason the write's is: the person taking the
       * grant back has to be the person who gave it.
       *
       * Never throws. `revoked: false` covers malformed, not-a-person, not
       * yours, and nothing-to-delete alike — see `EgressRevokeOutput` for why
       * those are deliberately one answer. Note the direction differs from
       * `remember`: a failed revoke leaves a site ALLOWED, so the caller must
       * keep showing the row rather than assume it went away.
       */
      bus.registerService<EgressRevokeInput, EgressRevokeOutput>(
        'egress-allowlist:revoke',
        PLUGIN_NAME,
        async (ctx, input) => {
          const host = normalizeHost(input?.host);
          if (host === null || !isOwnerId(ctx.userId)) return { revoked: false };
          try {
            return { revoked: await egressStore.revoke({ ownerId: ctx.userId, host }) };
          } catch (err) {
            ctx.logger.warn('tool_policy_egress_revoke_failed', {
              plugin: PLUGIN_NAME,
              // Safe to name: it passed `normalizeHost`, so it is a hostname
              // and not a model-authored URL — no query string, nothing to
              // leak into a log line.
              host,
              err: err instanceof Error ? err : new Error(String(err)),
            });
            return { revoked: false };
          }
        },
        { returns: EgressRevokeOutputSchema },
      );

      // -------------------------------------------------------------------
      // Per-tool verdict hooks (TASK-736). Host-internal service hooks; authz
      // is the calling route's (see `types.ts`). Malformed input is ANSWERED
      // (`ok: false`) rather than thrown, so a route can tell "you may not"
      // from "we broke"; a store failure on a WRITE throws, because silently
      // dropping a person's deny would be the loosening outcome.
      // -------------------------------------------------------------------

      bus.registerService<SetConnectorDefaultsInput, SetConnectorDefaultsOutput>(
        'tool-policy:set-connector-defaults',
        PLUGIN_NAME,
        async (ctx, input) => {
          if (!isId(input?.connectorId) || !Array.isArray(input?.verdicts)) {
            return { ok: false, reason: 'invalid-input' };
          }
          if (input.verdicts.length > MAX_VERDICTS_PER_WRITE) {
            return { ok: false, reason: 'invalid-input' };
          }
          // Validate EVERY row before writing ANY: a half-applied batch would
          // leave an admin looking at a form that says one thing while the
          // gate enforces another.
          const rows: Array<{ toolNamespace: string; tool: string; verdict: PolicyVerdict | null }> =
            [];
          for (const v of input.verdicts) {
            const parsed = parseConnectorToolKey(v?.toolKey);
            if (parsed === null) {
              return {
                ok: false,
                reason: 'invalid-key',
                ...(typeof v?.toolKey === 'string' && { toolKey: v.toolKey.slice(0, 200) }),
              };
            }
            if (v.verdict !== null && !isPolicyVerdict(v.verdict)) {
              return { ok: false, reason: 'invalid-verdict', toolKey: v.toolKey };
            }
            rows.push({ ...parsed, verdict: v.verdict });
          }
          await verdictStore.setConnectorDefaults(input.connectorId, rows, ctx.userId);
          for (const r of rows) defaultsCache.delete(r.toolNamespace);
          return { ok: true };
        },
        { returns: SetConnectorDefaultsOutputSchema },
      );

      bus.registerService<GetConnectorDefaultsInput, GetConnectorDefaultsOutput>(
        'tool-policy:get-connector-defaults',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const namespaces = namespaceList(input?.toolNamespaces);
          if (!isId(input?.connectorId) || namespaces === null) {
            throw new Error(
              'tool-policy:get-connector-defaults needs a connectorId and its toolNamespaces',
            );
          }
          return {
            defaults: await verdictStore.listConnectorDefaults(input.connectorId, namespaces),
          };
        },
        { returns: GetConnectorDefaultsOutputSchema },
      );

      bus.registerService<SetAgentOverrideInput, SetAgentOverrideOutput>(
        'tool-policy:set-agent-override',
        PLUGIN_NAME,
        async (ctx, input) => {
          if (!isId(input?.agentId)) return { ok: false, reason: 'invalid-input' };
          // A closed list: abilities and `mcp.*`. `WebFetch`, `Task`,
          // `request_capability`, the `*_propose` tools — anything a static
          // rule governs that a person must not be able to touch — has no key
          // here at all.
          if (!isOverridableKey(input.toolKey)) return { ok: false, reason: 'invalid-key' };
          const verdict = input.verdict;
          if (verdict !== null && !isPolicyVerdict(verdict)) {
            return { ok: false, reason: 'invalid-verdict' };
          }
          if (verdict !== null) {
            // Read the ceiling FRESH, not from the cache: this is the one
            // place a stale ceiling would let a person store something looser
            // than the admin now allows. (Enforcement would still clamp it —
            // `strictest` — but the person would be shown a choice that does
            // not take effect.)
            const conn = parseConnectorToolKey(input.toolKey);
            const connectorDefault =
              conn === null
                ? undefined
                : (await verdictStore.connectorDefaultsFor([conn.toolNamespace])).get(input.toolKey);
            const ceiling = ceilingFor(rules, input.toolKey, connectorDefault);
            if (isLooserThan(verdict, ceiling)) {
              return { ok: false, reason: 'ceiling-violation', ceiling };
            }
          }
          await verdictStore.setOverride(input.agentId, input.toolKey, verdict, ctx.userId);
          overrideCache.delete(input.agentId);
          return { ok: true };
        },
        { returns: SetAgentOverrideOutputSchema },
      );

      bus.registerService<ListAgentOverridesInput, ListAgentOverridesOutput>(
        'tool-policy:list-agent-overrides',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (!isId(input?.agentId)) {
            throw new Error('tool-policy:list-agent-overrides needs an agentId');
          }
          // Uncached on purpose: this is a settings/session-open read, and the
          // person who just changed something should see it.
          const rows = await verdictStore.overridesFor(input.agentId);
          const defaults = await verdictStore.connectorDefaultsFor(
            namespacesOf(rows.map((r) => r.toolKey)),
          );
          return {
            overrides: rows.map((r) => ({
              toolKey: r.toolKey,
              verdict: r.verdict,
              ceiling: ceilingFor(rules, r.toolKey, defaults.get(r.toolKey)),
              origin: r.origin,
            })),
          };
        },
        { returns: ListAgentOverridesOutputSchema },
      );

      bus.registerService<SnapshotConnectorForAgentInput, SnapshotConnectorForAgentOutput>(
        'tool-policy:snapshot-connector-for-agent',
        PLUGIN_NAME,
        async (ctx, input) => {
          const namespaces = namespaceList(input?.toolNamespaces);
          if (!isId(input?.agentId) || !isId(input?.connectorId) || namespaces === null) {
            throw new Error(
              'tool-policy:snapshot-connector-for-agent needs agentId, connectorId and toolNamespaces',
            );
          }
          // "Copy on attach" (design decision 2): the agent keeps what the
          // admin said at attach time, so a later admin LOOSENING does not
          // silently loosen it — while a later TIGHTENING still applies,
          // because the default stays a live ceiling in `layeredVerdict`.
          const defaults = await verdictStore.listConnectorDefaults(input.connectorId, namespaces);
          const copied = await verdictStore.snapshot(input.agentId, defaults, ctx.userId);
          overrideCache.delete(input.agentId);
          return { copied };
        },
        { returns: SnapshotConnectorForAgentOutputSchema },
      );

      // A subscriber must never throw (HookBus would log and continue anyway);
      // a failed purge is logged loudly. What it leaves behind is a row keyed
      // to an agent / namespace nothing can call any more — inert, not a grant.
      bus.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
        if (!isId(agentId)) {
          ctx.logger.warn('tool_policy_purge_for_deleted_agent_skipped', { plugin: PLUGIN_NAME });
          return undefined;
        }
        try {
          const deleted = await verdictStore.purgeAgent(agentId);
          ctx.logger.info('tool_policy_purged_for_deleted_agent', { agentId, deleted });
        } catch (err) {
          ctx.logger.error('tool_policy_purge_for_deleted_agent_failed', { agentId, err });
        } finally {
          overrideCache.delete(agentId);
        }
        return undefined;
      });

      bus.subscribe<unknown>('connectors:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const raw = (payload as { toolNamespaces?: unknown } | null | undefined)?.toolNamespaces;
        const namespaces = Array.isArray(raw)
          ? raw
              .map((e) => (e as { toolNamespace?: unknown } | null | undefined)?.toolNamespace)
              .filter((ns): ns is string => typeof ns === 'string' && CONNECTOR_TOOL_NAMESPACE_RE.test(ns))
          : [];
        if (namespaces.length === 0) return undefined;
        try {
          await verdictStore.purgeNamespaces(namespaces);
          ctx.logger.info('tool_policy_purged_for_deleted_connector', {
            toolNamespaces: namespaces,
          });
        } catch (err) {
          ctx.logger.error('tool_policy_purge_for_deleted_connector_failed', { err });
        } finally {
          for (const ns of namespaces) defaultsCache.delete(ns);
          // Every agent may hold overrides under these namespaces.
          overrideCache.clear();
        }
        return undefined;
      });

      // TASK-752 — a connector edit changed which namespaces its MCP servers
      // live under. `renamed` pairs carry verdicts across (admin defaults AND
      // every agent's overrides, one write); `removed` namespaces are purged
      // like a deleted connector's. Either way nothing is left keyed to a
      // namespace no tool can reach any more. TASK-755: `removed` also names a
      // server that kept its name but changed its endpoint — the namespace is
      // still live, but its verdicts were chosen for a different service, so
      // the same purge resets it to Ask first.
      //
      // A malformed entry is dropped, never guessed at: dropping a rename
      // leaves the new namespace with no rows (Ask first — the safe side), and
      // the store re-checks the shape before it runs any `LIKE`.
      bus.subscribe<unknown>(
        'connectors:tool-namespaces-changed',
        PLUGIN_NAME,
        async (ctx, payload) => {
          const p = payload as { renamed?: unknown; removed?: unknown } | null | undefined;
          const nsOf = (e: unknown): string | null => {
            const ns = (e as { toolNamespace?: unknown } | null | undefined)?.toolNamespace;
            return typeof ns === 'string' && CONNECTOR_TOOL_NAMESPACE_RE.test(ns) ? ns : null;
          };
          const pairs: Array<{ from: string; to: string }> = [];
          const used = new Set<string>();
          for (const r of Array.isArray(p?.renamed) ? p.renamed : []) {
            const from = nsOf((r as { from?: unknown } | null | undefined)?.from);
            const to = nsOf((r as { to?: unknown } | null | undefined)?.to);
            if (from === null || to === null || from === to || used.has(from) || used.has(to)) continue;
            used.add(from);
            used.add(to);
            pairs.push({ from, to });
          }
          const removed = (Array.isArray(p?.removed) ? p.removed : [])
            .map(nsOf)
            .filter((ns): ns is string => ns !== null && !used.has(ns));
          if (pairs.length === 0 && removed.length === 0) return undefined;
          try {
            if (pairs.length > 0) await verdictStore.renameNamespaces(pairs);
            if (removed.length > 0) await verdictStore.purgeNamespaces(removed);
            ctx.logger.info('tool_policy_moved_for_renamed_connector_server', {
              renamed: pairs,
              removed,
            });
          } catch (err) {
            ctx.logger.error('tool_policy_move_for_renamed_connector_server_failed', { err });
          } finally {
            for (const { from, to } of pairs) {
              defaultsCache.delete(from);
              defaultsCache.delete(to);
            }
            for (const ns of removed) defaultsCache.delete(ns);
            overrideCache.clear();
          }
          return undefined;
        },
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
        //
        // `hostProvidedTools` is the other half of the reach question and is
        // not filtered either: it is what lets the caller prove a tool is not
        // installed AT ALL, which the scope subtraction could never establish
        // because it only ever walked tools the catalog already held
        // (TASK-416).
        async (_ctx, input) => ({
          rows: applyReach(indexed, input?.outOfReach),
          fullyDescribedTools: fullyDescribedTools(rules),
          hostProvidedTools: hostProvidedTools(rules),
        }),
        { returns: ListCapabilitiesOutputSchema },
      );
    },
  };
}
