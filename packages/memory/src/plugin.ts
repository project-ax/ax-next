import {
  PluginError,
  parseModelRef,
  type AgentContext,
  type HookBus,
  type LlmCallInput,
  type LlmCallOutput,
  type Plugin,
} from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';
import { AGENTS_RESOLVE_HOOK, memoryReadScope, resolveMemoryAccess } from './access.js';
import { deriveSlot, SLOTS } from './slots.js';
import { rewriteSpeaker } from './subject.js';
import {
  NO_CREDENTIAL_EVENT,
  OBSERVER_FAILED_EVENT,
  OBSERVER_RUN_EVENT,
  isMissingCredential,
  memoryFailureEvent,
  noCredentialFields,
} from './failure.js';
import { runObserver, type ObserverRecordInput, type ObserverResult } from './observer.js';
import { selectProfileRows } from './profile.js';
import { formatEvidenceWhen } from './evidence.js';
import { MEMORY_RECALL_TOOL_HOOK, registerMemoryRecall } from './recall-tool.js';
import type { UntrustedMessage } from './transcript.js';
import {
  registerSystemPromptAugment,
  RULES_READ_HOOK,
  SYSTEM_PROMPT_AUGMENT_HOOK,
  type MemoryBlockConfig,
} from './augment.js';
import {
  DEFAULT_RECALL_LIMIT,
  type MemoryForgetInput,
  type MemoryForgetOutput,
  type MemoryRecallInput,
  type MemoryRecallOutput,
  type MemoryRememberInput,
  type MemoryRememberOutput,
  type MemoryStatement,
  type MemoryStatementKind,
} from './types.js';

const PLUGIN_VERSION = '0.0.0';

/** The engine hooks this plugin orchestrates. It reimplements none of them. */
export const FACTS_RECALL_HOOK = 'memory:facts:recall';
export const FACTS_RECORD_HOOK = 'memory:facts:record';
export const FACTS_SUPERSEDE_HOOK = 'memory:facts:supersede';

/** The hooks this plugin registers — the caller-facing memory surface. */
export const MEMORY_RECALL_HOOK = 'memory:recall';
export const MEMORY_REMEMBER_HOOK = 'memory:remember';
export const MEMORY_FORGET_HOOK = 'memory:forget';

/** The hook the observer observes. */
export const CHAT_END_HOOK = 'chat:end';

/**
 * The model every memory operation runs on — design §3.0's extractor, pinned.
 *
 * A `provider/model-id` REF: `parseModelRef` splits on the FIRST slash, so the
 * provider is `openrouter` and the model id is `z-ai/glm-5.3-flash:nitro`. A
 * two-slash value is expected here.
 *
 * **Pinned, not inherited from the calling agent.** The extractor is worth
 * ~57 points (gpt-4.1-nano 26.0% vs glm-5.3-flash 83-88% on identical
 * questions and answerer), so letting it follow whatever model a user picked
 * for chat would make memory quality unstatable — and would silently move it
 * every time somebody changed their chat model. Same call `@ax/memory-strata`
 * made on 2026-09-14, and the same model, which is the one every number in
 * the design was measured on.
 */
export const DEFAULT_MEMORY_OPS_MODEL = 'openrouter/z-ai/glm-5.3-flash:nitro';

/**
 * Hard deadline for the extraction round trip, retry included.
 *
 * The observer is detached from `chat:end`, so nothing else would ever stop
 * it. `LlmCallInput` carries no `AbortSignal`, so this bounds the WAIT rather
 * than the round trip — see `raceTimeout` in `observer.ts`.
 */
export const DEFAULT_OBSERVER_TIMEOUT_MS = 30_000;

/**
 * Deliberation level for the extraction call.
 *
 * `minimal` because this is a schema-constrained extraction job with a hard
 * deadline, and GLM reasons by DEFAULT: `@ax/memory-strata` measured p50 ~3.4s
 * with the field absent versus ~865ms with it. Blowing the deadline degrades
 * silently (a dropped batch), which is precisely the failure mode that hides a
 * slow model.
 */
const MEMORY_OPS_REASONING = 'minimal' as const;

/**
 * Field names a caller may NOT set, on any caller-facing payload.
 *
 * Every one is a privilege field and every one is taken from `ctx` — and for
 * the sharing fields, from `agents:resolve` — instead:
 *
 * - `provenance` decides whether a statement can be overwritten by the next
 *   chat mention. Design §3.4's immunity ordering is `human > agent >
 *   extracted`, and it is the only thing making a person's correction
 *   survive. A caller that could write `provenance: 'human'` could make its
 *   own note immune to correction — so provenance is a property of WHICH HOOK
 *   was called, full stop.
 * - `ownerUserId` decides who a row is attributed to and, on a personal
 *   agent, who can read and retract it.
 * - `scope`, `visibility`, `ownerType`, `teamId` and `agentId` are the
 *   authority fields a caller would reach for to widen a personal agent into
 *   a shared one, borrow another owner, or point at another agent. Sharing
 *   is a property of the RESOLVED agent — `resolveMemoryAccess` asks
 *   `agents:resolve` on every operation — and never of the request, so the
 *   payload cannot carry it.
 *
 * We REFUSE rather than ignore. Ignoring is the shape that reads as working:
 * a caller (or an injected tool argument) sets the field, gets a `200`, and
 * believes it took effect — and the test that "asserts the default" passes
 * identically whether the field was stripped or never supported. A refusal is
 * the assertion.
 */
const FORBIDDEN_PAYLOAD_FIELDS = [
  'provenance',
  'ownerUserId',
  'scope',
  'visibility',
  'ownerType',
  'teamId',
  'agentId',
] as const;

/**
 * The subset of the engine's `FactRecord` this plugin reads back.
 *
 * Declared locally and structurally rather than imported from
 * `@ax/memory-facts-contract`: that package depends on `vitest` at runtime
 * (it ships the shared contract suite), so it is a devDependency and only
 * `import type` is allowed from it here anyway — and a structural local
 * declaration keeps the production graph honest about what actually crosses
 * the bus. `provenance` and `closedBy` reach a caller only through the bounded
 * paths in the recall handler: `provenance` feeds profile selection and
 * `closedBy` is forwarded only when it names a row already in the same
 * returned page — never verbatim.
 */
interface EngineFactRecord {
  id: string;
  about: string;
  relation: string;
  value: string;
  when: string;
  until?: string;
  kind?: MemoryStatementKind;
  slot?: string;
  closedBy?: string;
  provenance?: string;
}

interface EngineRecallOutput {
  statements: EngineFactRecord[];
  degraded: string[];
}

interface EngineRecordOutput {
  records: Array<{ id: string }>;
}

export interface MemoryPluginConfig {
  /**
   * Ceiling applied to `memory:recall`'s `limit` before it reaches the
   * engine. The engine clamps again with its own maximum; this one exists so
   * the product layer has an answer of its own rather than deferring a
   * resource question to whichever backend happens to be loaded.
   */
  maxRecallLimit?: number;
  /**
   * `provider/model-id` ref the observer's extraction call routes to.
   * Defaults to {@link DEFAULT_MEMORY_OPS_MODEL}. Always a REF — a bare id
   * has no provider to route by and is refused at construction.
   */
  memoryOpsModel?: string;
  /** Defaults to {@link DEFAULT_OBSERVER_TIMEOUT_MS}. */
  observerTimeoutMs?: number;
  /**
   * Test-only seam. The plugin hands every DETACHED observer promise here,
   * already `.catch()`-ed, so a test can await the extraction chain
   * deterministically instead of sleeping. Never read by production code, and
   * never a way to make `chat:end` wait: the subscriber has already returned
   * by the time this is called.
   */
  onObserverDetached?: (work: Promise<void>) => void;
  /**
   * Sizing for the always-injected block (design §4.1). Every field defaults;
   * see `augment.ts`'s `DEFAULTS`.
   */
  block?: MemoryBlockConfig;
}

const DEFAULT_MAX_RECALL_LIMIT = 100;

function invalid(message: string, hookName: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, hookName, message });
}

function requireNonEmptyString(value: unknown, field: string, hookName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${field} must be a non-empty string`, hookName);
  }
  return value;
}

/**
 * Reject a payload carrying a field only `ctx` may decide.
 *
 * Runs on the raw input before anything else, so a refused call has written
 * nothing and read nothing.
 */
function rejectPrivilegeFields(input: unknown, hookName: string): void {
  if (input === null || typeof input !== 'object') return;
  for (const field of FORBIDDEN_PAYLOAD_FIELDS) {
    if (field in (input as Record<string, unknown>)) {
      throw invalid(
        `${field} is not a caller-settable field: it is determined by which hook was called and by ctx, never by a payload`,
        hookName,
      );
    }
  }
}

/**
 * Guard for a service-hook response that crossed the bus.
 *
 * `HookBus.call` returns a handler's RAW value when the hook declares no
 * `returns` schema — and none of the `memory:facts:*` hooks declare one — so
 * a handler resolving to `null` arrives here intact and a `=== undefined`
 * check is FALSE for it. Hence `== null`, deliberately, covering both.
 *
 * And it throws rather than substituting an empty answer. "No facts" and
 * "could not read the facts" render identically to a model and to a person,
 * and one of them is a lie (design §4.4: an empty table is a valid answer; a
 * failed store is not). A degradation we can name goes in `degraded`; one we
 * cannot is an error.
 */
function requireEngineResult<T>(result: T | null | undefined, hookName: string, calledHook: string): T {
  if (result == null) {
    throw new PluginError({
      code: 'invalid-return',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${calledHook} returned no result; memory cannot report an empty answer for a store it could not read`,
    });
  }
  return result;
}

/**
 * `@ax/memory` — the product layer over the memory-facts engine.
 *
 * It orchestrates; it does not reimplement the store. Everything below is a
 * `bus.call` into whichever `memory:facts:*` engine the preset loaded
 * (sqlite or postgres today), reached through the hook bus only — there is no
 * cross-plugin import here and no engine vocabulary in any payload
 * (CLAUDE.md invariants 1 and 2).
 *
 * ⚠ **Not wired into a preset by this card.** Design §10.4 settled that
 * `@ax/memory` lands in its OWN preset with its own canary and that
 * `presets/k8s` keeps `@ax/memory-strata` untouched — one memory plugin per
 * preset, so invariant 4 holds trivially. That preset and the canary
 * reachability invariant 3 requires are the epic's final card; this one
 * deliberately stops at the hook surface the rest of the epic builds against.
 */
export function createMemoryPlugin(config: MemoryPluginConfig = {}): Plugin {
  const maxRecallLimit = config.maxRecallLimit ?? DEFAULT_MAX_RECALL_LIMIT;
  if (!Number.isFinite(maxRecallLimit) || maxRecallLimit < 1) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `maxRecallLimit must be a positive number (got ${String(config.maxRecallLimit)})`,
    });
  }

  const observerTimeoutMs = config.observerTimeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS;
  if (!Number.isFinite(observerTimeoutMs) || observerTimeoutMs < 1) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `observerTimeoutMs must be a positive number (got ${String(config.observerTimeoutMs)})`,
    });
  }

  // Resolved ONCE, at construction, so a malformed ref throws HERE rather than
  // degrading on every turn: an unparseable model ref is a static
  // misconfiguration and there is no turn at which it starts working. It also
  // has to be resolved before the manifest is built, because the provider hook
  // it derives is what the manifest declares.
  const memoryOpsModel = config.memoryOpsModel ?? DEFAULT_MEMORY_OPS_MODEL;
  const parsedMemoryOps = parseModelRef(memoryOpsModel);
  const memoryOpsHook = `llm:call:${parsedMemoryOps.provider}`;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [
        MEMORY_RECALL_HOOK,
        MEMORY_REMEMBER_HOOK,
        MEMORY_FORGET_HOOK,
        SYSTEM_PROMPT_AUGMENT_HOOK,
        MEMORY_RECALL_TOOL_HOOK,
      ],
      // Hard dependencies, all five: this plugin has nothing to fall back
      // on. A memory surface with no store behind it cannot degrade into
      // anything honest — it can only answer "no memories" to a question it
      // never asked anyone. Failing at boot with `missing-service` is the
      // outcome that gets noticed.
      calls: [
        FACTS_RECALL_HOOK,
        FACTS_RECORD_HOOK,
        FACTS_SUPERSEDE_HOOK,
        'tool:register',
        AGENTS_RESOLVE_HOOK,
      ],
      // The extraction provider is OPTIONAL, and that asymmetry with the
      // three engine hooks above is deliberate. A memory surface with no
      // STORE behind it cannot degrade into anything honest — it can only
      // answer "no memories" to a question it never asked anyone, so that
      // fails the boot. A memory surface with no extraction PROVIDER degrades
      // into something perfectly honest: everything a person or an agent
      // writes explicitly still works, and the turn-boundary observer is
      // skipped with a loud, greppable event on every turn.
      //
      // Failing the boot instead would mean a CI host, a canary or an
      // air-gapped install with no LLM provider could not load `@ax/memory`
      // at all.
      //
      // The human tier is a SOFT dependency too, and the distinction is
      // deliberate. `memory:rules:*` stays the shared contract across memory
      // implementations (design §10.4) but the provider is not part of this
      // plugin, so a preset can legitimately load `@ax/memory` without one —
      // and a hard `calls` entry would turn that configuration into a boot
      // failure. Absent, the injected block simply has no Rules section. A
      // provider that THROWS is a different story and is not swallowed; see
      // `readRulesBody`.
      optionalCalls: [
        {
          hook: memoryOpsHook,
          degradation:
            'no memory is extracted from conversations at chat:end; memory:remember and memory:forget are unaffected, and every skipped turn emits memory_observer_failed',
        },
        {
          hook: RULES_READ_HOOK,
          degradation:
            "the always-injected memory block renders no '## Rules From Your User' section; the person's own standing instructions are not in the prompt, and nothing else changes",
        },
      ],
      subscribes: [CHAT_END_HOOK],
    },

    async init({ bus }: { bus: HookBus }) {
      // ---------------------------------------------------------------
      // system-prompt:augment — the always-injected block (design §4.1).
      // A `call`, not a `fire`: see `registerSystemPromptAugment`.
      // ---------------------------------------------------------------
      registerSystemPromptAugment(bus, FACTS_RECALL_HOOK, config.block ?? {});

      // ---------------------------------------------------------------
      // memory:recall — the read path. Provenance: read.
      // ---------------------------------------------------------------
      bus.registerService<MemoryRecallInput, MemoryRecallOutput>(
        MEMORY_RECALL_HOOK,
        PLUGIN_NAME,
        async (ctx: AgentContext, rawInput: MemoryRecallInput) => {
          rejectPrivilegeFields(rawInput, MEMORY_RECALL_HOOK);
          const access = await resolveMemoryAccess(bus, ctx);
          const ownerUserId = access.userId;

          // Every field on this payload is optional, so `{}` is the ordinary
          // call and a caller that sends nothing at all means the same thing.
          // Normalized rather than dereferenced: `rawInput.query` on an absent
          // payload is a raw `TypeError` carrying no plugin, no hook name and
          // no `code` — a different error shape from the `PluginError` the
          // other two hooks raise for the identical mistake, on the one hook
          // where the mistake is harmless. `HookBus` types `input` as
          // required, so only a caller crossing a boundary that erases types
          // (an IPC action, a tool argument) reaches this, which is exactly
          // the caller least able to do anything with a `TypeError`.
          const input: MemoryRecallInput = rawInput ?? {};

          if (input.query !== undefined && !isUsableString(input.query)) {
            throw invalid('query must be a non-empty string when set', MEMORY_RECALL_HOOK);
          }
          if (input.about !== undefined && !isUsableString(input.about)) {
            throw invalid('about must be a non-empty string when set', MEMORY_RECALL_HOOK);
          }
          if (input.activeOnly !== undefined && typeof input.activeOnly !== 'boolean') {
            throw invalid('activeOnly must be a boolean when set', MEMORY_RECALL_HOOK);
          }
          if (input.profile !== undefined && typeof input.profile !== 'boolean') {
            throw invalid('profile must be a boolean when set', MEMORY_RECALL_HOOK);
          }
          if (
            input.profile === true &&
            (input.query !== undefined || input.about !== undefined)
          ) {
            throw invalid('profile scopes itself and cannot combine with query or about', MEMORY_RECALL_HOOK);
          }
          if (
            input.limit !== undefined &&
            (typeof input.limit !== 'number' || !Number.isFinite(input.limit) || input.limit < 1)
          ) {
            throw invalid('limit must be a positive number when set', MEMORY_RECALL_HOOK);
          }

          const limit = Math.min(
            Math.floor(input.limit ?? DEFAULT_RECALL_LIMIT),
            maxRecallLimit,
          );

          const asOf = new Date().toISOString();
          const raw = await bus.call<unknown, EngineRecallOutput | null>(
            FACTS_RECALL_HOOK,
            ctx,
            {
              limit: input.profile === true ? Math.max(32, limit) : limit,
              // Owner scope, pushed DOWN into the engine's query rather than
              // applied to the rows that come back. A post-filter under a
              // `limit` silently returns fewer rows than asked for — ask for
              // 20 and get 3 because 17 belonged to somebody else — which is
              // design §6.1's "never post-filter a widened pool". It is also
              // the only version that works at all: the engine's `FactRecord`
              // does not carry an owner, so there is nothing here to filter
              // ON. A team agent widens the same push-down deliberately:
              // `memoryReadScope` omits the owner filter only after
              // `agents:resolve` proved this caller is a current member of a
              // team agent, and the rows are that agent's shared knowledge —
              // never another agent's, never another person's under a
              // personal agent.
              ...memoryReadScope(access),
              // `about: 'user'` means "the person talking", and what a write
              // stored under that is `user:<userId>`. Same rewrite, both
              // directions — see `subject.ts`.
              ...(input.profile === true
                ? { about: rewriteSpeaker('user', ownerUserId), slots: [...SLOTS] }
                : input.about !== undefined
                  ? { about: rewriteSpeaker(input.about, ownerUserId) }
                  : {}),
              ...(input.query !== undefined ? { query: input.query } : {}),
              ...(input.query !== undefined
                ? { poolSize: Math.min(200, Math.max(40, Math.ceil(limit * 40 / 15))) }
                : {}),
              ...(input.activeOnly !== undefined ? { activeOnly: input.activeOnly } : {}),
            },
          );

          const result = requireEngineResult(raw, MEMORY_RECALL_HOOK, FACTS_RECALL_HOOK);

          // A malformed `statements` is an ERROR, not an empty memory — the
          // same call `requireEngineResult` just made one line up, and for the
          // same reason. Coercing a non-array to `[]` here would render "the
          // engine answered nonsense" and "you have no memories" identically
          // to a person and to a model, and one of them is a lie. Only
          // reachable through an engine contract violation, which is exactly
          // when a loud failure is worth more than a plausible one.
          //
          // `undefined` is NOT tolerated: `statements` is the answer. That is
          // the asymmetry with `degraded` below, which is a signal ABOUT the
          // answer and whose absence honestly means "nothing was degraded".
          if (!Array.isArray(result.statements)) {
            throw new PluginError({
              code: 'invalid-return',
              plugin: PLUGIN_NAME,
              hookName: MEMORY_RECALL_HOOK,
              message: `${FACTS_RECALL_HOOK} returned a non-array statements; memory cannot report an empty answer for a store whose response it could not read`,
            });
          }
          // A `degraded` that is present but not an array is malformed for the
          // same reason. Absent is fine and means "nothing was degraded".
          if (result.degraded !== undefined && !Array.isArray(result.degraded)) {
            throw new PluginError({
              code: 'invalid-return',
              plugin: PLUGIN_NAME,
              hookName: MEMORY_RECALL_HOOK,
              message: `${FACTS_RECALL_HOOK} returned a non-array degraded; a degradation signal we cannot read is not the same as no degradation`,
            });
          }

          for (const row of result.statements) {
            toMemoryStatement(row);
          }
          const page =
            input.profile === true && input.activeOnly !== false
              ? selectProfileRows(result.statements, limit)
              : result.statements.slice(0, limit);
          const visibleIds = new Set(page.map((row) => row.id));

          return {
            statements: page.map((row) => {
              const mapped = toMemoryStatement(row);
              return {
                ...mapped,
                aboutText:
                  row.about === rewriteSpeaker('user', ownerUserId)
                    ? 'you'
                    : row.about.replace(/_/g, ' '),
                whenText: formatEvidenceWhen(mapped, asOf),
                ...(row.until !== undefined
                  ? { closure: row.closedBy === undefined ? ('forgotten' as const) : ('replaced' as const) }
                  : {}),
                ...(typeof row.closedBy === 'string' && visibleIds.has(row.closedBy)
                  ? { closedBy: row.closedBy }
                  : {}),
              };
            }),
            // Verbatim. Not re-derived, not re-ordered, not filtered, not
            // "corrected" — including the asymmetry where an empty store with
            // no providers raises `'semantic'` but not `'ranking'` (embedding
            // is store-independent, reranking is pool-dependent). That
            // asymmetry is pinned by an engine contract case; a product layer
            // that normalized it would be overwriting a measurement with an
            // assumption.
            degraded: result.degraded === undefined ? [] : [...result.degraded],
            visibility: access.visibility,
          };
        },
      );

      // ---------------------------------------------------------------
      // memory:remember — the ONLY external write. Provenance: human.
      // ---------------------------------------------------------------
      bus.registerService<MemoryRememberInput, MemoryRememberOutput>(
        MEMORY_REMEMBER_HOOK,
        PLUGIN_NAME,
        async (ctx: AgentContext, input: MemoryRememberInput) => {
          rejectPrivilegeFields(input, MEMORY_REMEMBER_HOOK);
          const access = await resolveMemoryAccess(bus, ctx);
          const ownerUserId = access.userId;

          const about = requireNonEmptyString(input?.about, 'about', MEMORY_REMEMBER_HOOK);
          const relation = requireNonEmptyString(input?.relation, 'relation', MEMORY_REMEMBER_HOOK);
          const value = requireNonEmptyString(input?.value, 'value', MEMORY_REMEMBER_HOOK);
          if (input.when !== undefined && !isUsableString(input.when)) {
            throw invalid('when must be a non-empty string when set', MEMORY_REMEMBER_HOOK);
          }
          // The engine is the authority on what a valid instant is (it
          // rejects an offsetless local time rather than guess a timezone),
          // so we do not re-validate the format here — two validators for one
          // rule is exactly the drift invariant 4 is about. We only supply a
          // default, and the default is unambiguous by construction.
          const when = input.when ?? new Date().toISOString();

          // Derived here, in the product layer, not in the engine: the engine
          // takes a slot it is given (design §3.3/§3.5) and has no vocabulary
          // of its own. Cannot throw and cannot reach a network — see
          // `deriveSlot`.
          const slot = deriveSlot(relation);

          const raw = await bus.call<unknown, EngineRecordOutput | null>(
            FACTS_RECORD_HOOK,
            ctx,
            {
              // No `batchKey`. Idempotency keys exist because `chat:end` can
              // fire twice on the same dialogue; a person pressing "remember"
              // twice means it twice, and dedup here would silently discard
              // the second one.
              statements: [
                {
                  about: rewriteSpeaker(about, ownerUserId),
                  relation,
                  value,
                  when,
                  // The derived supersession key. OMITTED, not nulled, when
                  // the relation has no slot: `FactStatementInput.slot` is
                  // optional and absent means "no slot" — stored, retrievable,
                  // inert. Sending `slot: null` would be a different (and
                  // unsupported) claim.
                  //
                  // Most relations land here with no slot and that is the
                  // measured baseline, not a gap: a false positive
                  // (`visited` -> `lives_in`) CLOSES a true fact and no read
                  // path recovers it, while a false negative merely leaves two
                  // rows. See `slots.ts` for the rung-0 numbers that killed the
                  // embedding half.
                  //
                  // Never `PENDING_SLOT` either — and here it is unreachable
                  // rather than merely declined, because `deriveSlot` is a
                  // synchronous table lookup with no producer to be unavailable.
                  ...(slot !== null ? { slot } : {}),
                  // Hardcoded, and this line IS the provenance rule: `human`
                  // because this is the `memory:remember` hook, not because
                  // anybody asked for it. Nothing reachable from a payload
                  // can change it.
                  provenance: 'human',
                  ownerUserId,
                  // Provenance only, never a retrieval key — and absent
                  // rather than faked when the turn has no conversation
                  // (a canary, an admin probe).
                  ...(ctx.conversationId !== undefined
                    ? { conversationId: ctx.conversationId }
                    : {}),
                },
              ],
            },
          );

          const result = requireEngineResult(raw, MEMORY_REMEMBER_HOOK, FACTS_RECORD_HOOK);
          const id = result.records?.[0]?.id;
          if (typeof id !== 'string' || id === '') {
            throw new PluginError({
              code: 'invalid-return',
              plugin: PLUGIN_NAME,
              hookName: MEMORY_REMEMBER_HOOK,
              message: `${FACTS_RECORD_HOOK} recorded no statement for a single-statement batch`,
            });
          }
          return { id };
        },
      );

      // ---------------------------------------------------------------
      // memory:forget — the explicit retraction. Provenance: human.
      // ---------------------------------------------------------------
      bus.registerService<MemoryForgetInput, MemoryForgetOutput>(
        MEMORY_FORGET_HOOK,
        PLUGIN_NAME,
        async (ctx: AgentContext, input: MemoryForgetInput) => {
          rejectPrivilegeFields(input, MEMORY_FORGET_HOOK);
          const access = await resolveMemoryAccess(bus, ctx);

          if (!Array.isArray(input?.ids)) {
            throw invalid('ids must be an array', MEMORY_FORGET_HOOK);
          }
          if (input.ids.length === 0) {
            throw invalid('ids must not be empty', MEMORY_FORGET_HOOK);
          }
          input.ids.forEach((id, i) => {
            requireNonEmptyString(id, `ids[${i}]`, MEMORY_FORGET_HOOK);
          });

          // Both scopes go down with the call, and BOTH are refusals rather
          // than filters: the engine closes an id only when it belongs to
          // this tenant AND this owner, so a foreign id has no effect. On a
          // team agent the owner scope is omitted ON PURPOSE — a member may
          // retract any row of the agent's shared memory — while the tenant
          // check still refuses ids from another agent. We do not report
          // which ids were refused — see `MemoryForgetOutput`; reporting it
          // would hand a hostile caller an existence oracle.
          await bus.call<unknown, unknown>(FACTS_SUPERSEDE_HOOK, ctx, {
            ids: input.ids,
            ...memoryReadScope(access),
          });

          return {};
        },
      );

      // ---------------------------------------------------------------
      // chat:end — the observer. Provenance: extracted.
      // ---------------------------------------------------------------
      //
      // ## Why this subscriber returns before its work finishes
      //
      // Design §3.0: `chat:end` must not block on a ~30s call. That is not
      // only a latency preference — `HookBus.fire` puts NO CLOCK on a
      // subscriber (documented in `hook-bus.ts`: "`fire` has no timeout —
      // deliberately, since a subscriber's slowness must not fail the thing
      // it is observing"), so a subscriber that awaited an extraction would
      // hold the turn open for as long as the provider took, with nothing
      // outside it able to end the wait. Detaching is what makes the
      // observer's slowness cost nothing.
      //
      // ## Why it also never throws
      //
      // `fire`'s failure log is NOT guarded: `ctx.logger.error(...)` in the
      // catch block raises a `TypeError` under a ctx with no logger, and that
      // `TypeError` escapes `fire()` — skipping every REMAINING subscriber on
      // `chat:end` and reaching the caller wearing the wrong error's name.
      // (That is a real, filed defect, and this card deliberately does not
      // fix it.) A handler that cannot throw cannot reach that path, so
      // everything below is inside a try/catch and the detached promise
      // carries its own `.catch`.
      //
      // The net posture: this subscriber can neither stall `chat:end` nor
      // break it, at the cost of every failure being invisible unless it
      // emits an event — which is why `failure.ts` exists and why the tests
      // assert an event on every failure path, not only on the happy one.
      // `async` with nothing awaited inside, deliberately: `SubscriberHandler`
      // is typed as returning a promise, and the whole point of this handler
      // is that it awaits nothing.
      bus.subscribe<{ outcome?: unknown }>(CHAT_END_HOOK, PLUGIN_NAME, async (ctx, payload) => {
        // Fire-and-forget. `void` rather than `await`, and the whole body is
        // already non-throwing, so there is nothing here for `fire` to log.
        //
        // NOTE this deliberately does NOT skip `ctx.source === 'routine'` the
        // way `@ax/memory-strata`'s observer does. Strata's memory is the
        // agent's own episodic tree, which a scheduled fire would pollute
        // with its own internal work. This store is owner-scoped statements,
        // and design §3.2 settles the case explicitly: "Conversations with no
        // live person — a routine run — carry the routine owner's id", which
        // is a rule for how a routine's statements are STORED, not a reason
        // not to store them. `owner.ts` says the same in as many words and
        // does not branch on `source`.
        const work = observeChatEnd(bus, ctx, payload, {
          memoryOpsHook,
          model: parsedMemoryOps.modelId,
          observerTimeoutMs,
        }).catch(() => {
          // Unreachable: `observeChatEnd` catches everything and logs it.
          // Present because a detached promise that CAN reject is an
          // unhandled rejection, and "unreachable" is a claim about today's
          // code rather than tomorrow's.
        });
        config.onObserverDetached?.(work);
        return undefined;
      });

      await registerMemoryRecall(bus);
    },
  };
}

/**
 * Run one observation. **Never throws** — see the subscriber's comment for
 * why that is load-bearing rather than tidy.
 */
async function observeChatEnd(
  bus: HookBus,
  ctx: AgentContext,
  payload: { outcome?: unknown } | undefined,
  cfg: { memoryOpsHook: string; model: string; observerTimeoutMs: number },
): Promise<void> {
  try {
    // A terminated outcome (a `chat:start` veto, a runner crash, a timeout)
    // carries no transcript, and a malformed payload carries nothing we can
    // read. Both skip silently: neither is a failure of the memory path.
    const outcome = payload?.outcome;
    if (outcome === null || typeof outcome !== 'object') return;
    const { kind, messages } = outcome as { kind?: unknown; messages?: unknown };
    if (kind !== 'complete' || !Array.isArray(messages) || messages.length === 0) return;

    // Access from `ctx`, resolved through `agents:resolve` BEFORE any
    // provider or engine call. This THROWS for a context with no owner (an
    // owner-less canary session) and for a caller whose membership was
    // revoked between turns — both correct, and both inside the try: a
    // statement stored under an owner-less id could never be read back by
    // anyone, and a revoked member's statement must never land at all, so
    // the honest outcome is to record nothing and say so.
    const access = await resolveMemoryAccess(bus, ctx);
    const ownerUserId = access.userId;

    if (!bus.hasService(cfg.memoryOpsHook)) {
      // The `optionalCalls` degradation, realized. `warn` rather than
      // `error`: unlike a missing credential this is a preset-shape fact, not
      // a per-turn surprise, and it is the same on every turn of the host's
      // life.
      ctx.logger.warn(OBSERVER_FAILED_EVENT, {
        agentId: ctx.agentId,
        reason: 'llm-provider-unregistered',
        hook: cfg.memoryOpsHook,
      });
      return;
    }

    const result = await runObserver({
      messages: messages as UntrustedMessage[],
      llmCall: (input: LlmCallInput) =>
        bus.call<LlmCallInput, LlmCallOutput>(cfg.memoryOpsHook, ctx, {
          ...input,
          // Applied HERE rather than at the call site, so a future memory
          // operation cannot forget it.
          reasoningEffort: MEMORY_OPS_REASONING,
        }),
      record: async (input: ObserverRecordInput) => {
        await resolveMemoryAccess(bus, ctx);
        return bus.call<ObserverRecordInput, { records?: Array<{ id?: unknown }> } | null>(
          FACTS_RECORD_HOOK,
          ctx,
          input,
        );
      },
      ownerUserId,
      conversationId: ctx.conversationId,
      model: cfg.model,
      now: new Date(),
      timeoutMs: cfg.observerTimeoutMs,
    });

    logObserverResult(ctx, result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // A missing credential will not fix itself and costs every turn until
    // somebody stores a key, so it gets its own event at `error` volume —
    // the "memory paused" state. Everything else keeps the path's `warn`.
    if (isMissingCredential(err)) {
      ctx.logger.error(NO_CREDENTIAL_EVENT, {
        err: error,
        agentId: ctx.agentId,
        path: 'observer',
        ...noCredentialFields(),
      });
      return;
    }
    ctx.logger.warn(memoryFailureEvent(err, OBSERVER_FAILED_EVENT), {
      err: error,
      agentId: ctx.agentId,
      reason: 'observer-threw',
    });
  }
}

/**
 * The observer's audit line. COUNTS AND KINDS ONLY — never a statement, never
 * a fragment of dialogue, never the model's reply. The whole input to this
 * path is untrusted content, and a log is a sink like any other.
 *
 * Every non-`recorded` outcome is reported, because the whole path is
 * detached: a batch that was dropped is otherwise indistinguishable from a
 * conversation that had nothing worth remembering.
 */
function logObserverResult(ctx: AgentContext, result: ObserverResult): void {
  const base = { agentId: ctx.agentId, sessionId: ctx.sessionId };
  switch (result.kind) {
    case 'skipped':
      // `debug`: an ordinary turn with nothing durable in it is the common
      // case, not a problem.
      ctx.logger.debug(OBSERVER_RUN_EVENT, { ...base, outcome: 'skipped', reason: result.reason });
      return;
    case 'all-unusable':
      // `warn`, not `debug`: the extractor produced facts and every one was
      // unreadable. A partial version of this shows up as `recorded` with a
      // non-zero `unusable`; the total version is the systematic one, and it
      // must not be the quietest line in the system.
      ctx.logger.warn(OBSERVER_FAILED_EVENT, {
        ...base,
        reason: 'all-facts-unusable',
        unusable: result.unusable,
      });
      return;
    case 'timeout':
      ctx.logger.warn(OBSERVER_FAILED_EVENT, {
        ...base,
        reason: 'extraction-timeout',
        timeoutMs: result.timeoutMs,
      });
      return;
    case 'schema-failure':
      // `detail` is the SHAPE description built by `parseFacts` — field names
      // and types, never a value out of the model. See `describeShape`.
      ctx.logger.warn(OBSERVER_FAILED_EVENT, {
        ...base,
        reason: 'extraction-schema-failure',
        detail: result.detail,
      });
      return;
    case 'recorded':
      ctx.logger.info(OBSERVER_RUN_EVENT, {
        ...base,
        outcome: 'recorded',
        recorded: result.recorded,
        // A persistent non-zero here means the extractor is emitting dates
        // nothing can read — never silent, because the facts are lost.
        unusable: result.unusable,
        // A persistent `true` means the prompt and the model have drifted
        // apart; one retry is the budget, and it is being spent every turn.
        retried: result.retried,
      });
      return;
  }
}

function isUsableString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** The fields every engine row must carry, per `FactRecord`. */
const REQUIRED_ROW_FIELDS = ['id', 'about', 'relation', 'value', 'when'] as const;

const MEMORY_STATEMENT_KINDS: readonly MemoryStatementKind[] = [
  'world',
  'experience',
  'observation',
  'opinion',
];

/**
 * Engine row -> caller statement.
 *
 * An explicit field list, not a spread. Two reasons, and the second is the
 * load-bearing one:
 *
 * 1. `provenance` and `closedBy` are engine-side columns. `closedBy` reaches a
 *    caller only through the recall handler's bounded visibility check — it
 *    names a row only when that row is already in the same returned page, never
 *    verbatim — and `provenance` feeds profile selection without being handed
 *    out, which would start the argument about whether it can be handed back
 *    IN.
 * 2. A spread would silently widen this surface every time the engine's
 *    `FactRecord` grows a column — which is how a storage detail ends up in a
 *    transport-agnostic payload without anybody deciding to put it there
 *    (invariant 1).
 *
 * `kind` is optional passthrough: copied when the engine row carries one,
 * absent when it does not. A human `memory:remember` write deliberately
 * invents no classification, so its rows stay kind-less; see
 * `MemoryStatementKind`.
 *
 * ## Why this validates instead of copying
 *
 * Proving `statements` is an array is not proving its ELEMENTS are rows, and a
 * bare field-copy over an unchecked element reproduces one level down the exact
 * defect the array guard was added to kill:
 *
 * - A non-object element (`'nope'`, `42`) copies to a statement-shaped object
 *   full of `undefined`s. That is WORSE than the `[]` it replaced — a caller or
 *   a UI renders it as a real-but-blank memory instead of failing visibly.
 * - A partial row (`{ id }`, the shape schema drift actually produces) does the
 *   same thing while looking even more plausible.
 * - A `null` element threw a bare `TypeError` carrying no `plugin`, no
 *   `hookName` and no `code` — precisely the error shape this plugin says at
 *   length that it does not emit.
 *
 * The check lives HERE, at the single choke point every row passes through,
 * rather than in the recall handler: a future call site that maps rows without
 * remembering to validate them cannot exist if the mapper IS the validator.
 * Same reachability bar as the array guard — only an engine contract violation
 * gets here — and the same answer for the same reason: this file is the
 * template the rest of the epic copies, so the version they copy should be the
 * one that fails loudly.
 */
function toMemoryStatement(row: EngineFactRecord): MemoryStatement {
  const malformed = (why: string): never => {
    throw new PluginError({
      code: 'invalid-return',
      plugin: PLUGIN_NAME,
      hookName: MEMORY_RECALL_HOOK,
      message: `${FACTS_RECALL_HOOK} returned a malformed statement (${why}); a statement we cannot read is not a statement we may hand a caller`,
    });
  };

  // `typeof null === 'object'`, so the null check is not redundant — and null
  // is the element that used to produce the raw `TypeError`.
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    malformed('not an object');
  }
  for (const field of REQUIRED_ROW_FIELDS) {
    if (typeof row[field] !== 'string') {
      malformed(`${field} is not a string`);
    }
  }
  // Optional, but if present it must be readable. Passing a non-string `until`
  // through would put a wrong-typed value on the caller-facing payload while
  // every other field had been checked.
  if (row.until !== undefined && typeof row.until !== 'string') {
    malformed('until is present but not a string');
  }
  if (row.slot !== undefined && typeof row.slot !== 'string') {
    malformed('slot is present but not a string');
  }
  if (row.closedBy !== undefined && typeof row.closedBy !== 'string') {
    malformed('closedBy is present but not a string');
  }
  if (
    row.kind !== undefined &&
    !MEMORY_STATEMENT_KINDS.includes(row.kind as MemoryStatementKind)
  ) {
    malformed('kind is present but not a supported knowledge kind');
  }

  return {
    id: row.id,
    about: row.about,
    relation: row.relation,
    value: row.value,
    when: row.when,
    ...(row.until !== undefined ? { until: row.until } : {}),
    ...(row.kind !== undefined ? { kind: row.kind } : {}),
    ...(row.slot !== undefined ? { slot: row.slot } : {}),
  };
}
