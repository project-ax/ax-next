import { PluginError, type AgentContext, type HookBus, type Plugin } from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';
import { resolveOwnerUserId } from './owner.js';
import { rewriteSpeaker } from './subject.js';
import {
  DEFAULT_RECALL_LIMIT,
  type MemoryForgetInput,
  type MemoryForgetOutput,
  type MemoryRecallInput,
  type MemoryRecallOutput,
  type MemoryRememberInput,
  type MemoryRememberOutput,
  type MemoryStatement,
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

/**
 * Field names a caller may NOT set, on any caller-facing payload.
 *
 * Both are privilege fields and both are taken from `ctx` instead:
 *
 * - `provenance` decides whether a statement can be overwritten by the next
 *   chat mention. Design §3.4's immunity ordering is `human > agent >
 *   extracted`, and it is the only thing making a person's correction
 *   survive. A caller that could write `provenance: 'human'` could make its
 *   own note immune to correction — so provenance is a property of WHICH HOOK
 *   was called, full stop.
 * - `ownerUserId` decides who can read and retract the row.
 *
 * We REFUSE rather than ignore. Ignoring is the shape that reads as working:
 * a caller (or an injected tool argument) sets the field, gets a `200`, and
 * believes it took effect — and the test that "asserts the default" passes
 * identically whether the field was stripped or never supported. A refusal is
 * the assertion.
 */
const FORBIDDEN_PAYLOAD_FIELDS = ['provenance', 'ownerUserId'] as const;

/**
 * The subset of the engine's `FactRecord` this plugin reads back.
 *
 * Declared locally and structurally rather than imported from
 * `@ax/memory-facts-contract`: that package depends on `vitest` at runtime
 * (it ships the shared contract suite), so it is a devDependency and only
 * `import type` is allowed from it here anyway — and a structural local
 * declaration keeps the production graph honest about what actually crosses
 * the bus. Only the fields this plugin forwards are named; `provenance` and
 * `closedBy` are engine-side columns that deliberately do not reach a caller.
 */
interface EngineFactRecord {
  id: string;
  about: string;
  relation: string;
  value: string;
  when: string;
  until?: string;
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

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [MEMORY_RECALL_HOOK, MEMORY_REMEMBER_HOOK, MEMORY_FORGET_HOOK],
      // Hard dependencies, all three: this plugin has nothing to fall back
      // on. A memory surface with no store behind it cannot degrade into
      // anything honest — it can only answer "no memories" to a question it
      // never asked anyone. Failing at boot with `missing-service` is the
      // outcome that gets noticed.
      calls: [FACTS_RECALL_HOOK, FACTS_RECORD_HOOK, FACTS_SUPERSEDE_HOOK],
      subscribes: [],
    },

    init({ bus }: { bus: HookBus }) {
      // ---------------------------------------------------------------
      // memory:recall — the read path. Provenance: read.
      // ---------------------------------------------------------------
      bus.registerService<MemoryRecallInput, MemoryRecallOutput>(
        MEMORY_RECALL_HOOK,
        PLUGIN_NAME,
        async (ctx: AgentContext, rawInput: MemoryRecallInput) => {
          rejectPrivilegeFields(rawInput, MEMORY_RECALL_HOOK);
          const ownerUserId = resolveOwnerUserId(ctx);

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

          const raw = await bus.call<unknown, EngineRecallOutput | null>(
            FACTS_RECALL_HOOK,
            ctx,
            {
              limit,
              // Owner scope, pushed DOWN into the engine's query rather than
              // applied to the rows that come back. A post-filter under a
              // `limit` silently returns fewer rows than asked for — ask for
              // 20 and get 3 because 17 belonged to somebody else — which is
              // design §6.1's "never post-filter a widened pool". It is also
              // the only version that works at all: the engine's `FactRecord`
              // does not carry an owner, so there is nothing here to filter
              // ON.
              ownerUserId,
              // `about: 'user'` means "the person talking", and what a write
              // stored under that is `user:<userId>`. Same rewrite, both
              // directions — see `subject.ts`.
              ...(input.about !== undefined
                ? { about: rewriteSpeaker(input.about, ownerUserId) }
                : {}),
              ...(input.query !== undefined ? { query: input.query } : {}),
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

          return {
            statements: result.statements.map(toMemoryStatement),
            // Verbatim. Not re-derived, not re-ordered, not filtered, not
            // "corrected" — including the asymmetry where an empty store with
            // no providers raises `'semantic'` but not `'ranking'` (embedding
            // is store-independent, reranking is pool-dependent). That
            // asymmetry is pinned by an engine contract case; a product layer
            // that normalized it would be overwriting a measurement with an
            // assumption.
            degraded: result.degraded === undefined ? [] : [...result.degraded],
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
          const ownerUserId = resolveOwnerUserId(ctx);

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

          const raw = await bus.call<unknown, EngineRecordOutput | null>(
            FACTS_RECORD_HOOK,
            ctx,
            {
              // No `batchKey`. Idempotency keys exist because `chat:end` can
              // fire twice on the same dialogue; a person pressing "remember"
              // twice means it twice, and dedup here would silently discard
              // the second one.
              //
              // And no `slot`. Slot derivation is the normalizer's job and
              // the normalizer is a later card, so a statement recorded here
              // is INERT for supersession — it closes nothing and nothing
              // closes it, exactly like every other no-slot row. That is
              // under-closing: the measured baseline, and the safe direction,
              // because a false positive (`visited` -> `lives_in`) closes a
              // true fact while a false negative merely leaves two.
              //
              // Not `PENDING_SLOT` either, though it would behave identically
              // for closure. Pending additionally raises `degraded:
              // ['pending']` on every recall, and a flag about a component
              // that does not exist to drain it is noise rather than a signal
              // — the same call TASK-422 made when it reserved `'semantic'`
              // and `'ranking'` without raising them until the channels that
              // could degrade existed.
              statements: [
                {
                  about: rewriteSpeaker(about, ownerUserId),
                  relation,
                  value,
                  when,
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
          const ownerUserId = resolveOwnerUserId(ctx);

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
          // this tenant AND this owner, so a foreign id has no effect. We do
          // not report which ids were refused — see `MemoryForgetOutput`; an
          // honest caller can never hold one, because `memory:recall` is
          // owner-scoped, and reporting it would hand a hostile caller an
          // existence oracle over other people's statements.
          await bus.call<unknown, unknown>(FACTS_SUPERSEDE_HOOK, ctx, {
            ids: input.ids,
            ownerUserId,
          });

          return {};
        },
      );
    },
  };
}

function isUsableString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** The fields every engine row must carry, per `FactRecord`. */
const REQUIRED_ROW_FIELDS = ['id', 'about', 'relation', 'value', 'when'] as const;

/**
 * Engine row -> caller statement.
 *
 * An explicit field list, not a spread. Two reasons, and the second is the
 * load-bearing one:
 *
 * 1. `provenance` and `closedBy` are engine-side columns. Handing `closedBy`
 *    to a caller leaks another statement's id into a payload; handing
 *    `provenance` out starts the argument about whether it can be handed back
 *    IN.
 * 2. A spread would silently widen this surface every time the engine's
 *    `FactRecord` grows a column — which is how a storage detail ends up in a
 *    transport-agnostic payload without anybody deciding to put it there
 *    (invariant 1).
 *
 * `kind` is not read here because no engine stores one; see
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

  return {
    id: row.id,
    about: row.about,
    relation: row.relation,
    value: row.value,
    when: row.when,
    ...(row.until !== undefined ? { until: row.until } : {}),
  };
}
