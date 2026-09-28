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
import { rewriteSpeaker, SPEAKER_SUBJECT } from './subject.js';
import {
  NO_CREDENTIAL_EVENT,
  OBSERVER_FAILED_EVENT,
  OBSERVER_RUN_EVENT,
  isMissingCredential,
  memoryFailureEvent,
  noCredentialFields,
} from './failure.js';
import { conversationField, conversationOf } from './conversation.js';
import {
  runObserver,
  runTurnObserver,
  type ObserverRecordInput,
  type ObserverResult,
} from './observer.js';
import {
  canExtractIncrementally,
  CHAT_TURN_END_HOOK,
  CONVERSATIONS_GET_HOOK,
  createIncrementalScheduler,
  DEFAULT_EVERY_USER_TURNS,
  DEFAULT_IDLE_MS,
  readCursor,
  STORAGE_GET_HOOK,
  STORAGE_SET_HOOK,
  writeCursor,
  type IncrementalConfig,
  type IncrementalScheduler,
  type PassTrigger,
} from './incremental.js';
import {
  dropRementionedSlotRows,
  hasContestedSlot,
  rementionedSlotRows,
  selectProfileRows,
} from './profile.js';
import { formatEvidenceWhen } from './evidence.js';
import { MEMORY_RECALL_TOOL_HOOK, registerMemoryRecall } from './recall-tool.js';
import { MEMORY_NOTE_TOOL_HOOK, registerMemoryNote } from './note-tool.js';
import { registerRulesHooks, RULES_WRITE_HOOK } from './rules.js';
import { filterTranscriptTurns, type UntrustedMessage } from './transcript.js';
import {
  createMemoryExporter,
  FACTS_SCAN_HOOK,
  MEMORY_EXPORT_FLUSH_HOOK,
  type MemoryExportConfig,
} from './exporter.js';
import {
  memoryMountSpec,
  validateVolumeConfig,
} from './export-volume.js';
import type {
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
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
  type MemoryStatusOutput,
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
 * Whether extraction is paused for the CALLER — see `MemoryStatusOutput`.
 *
 * Backed by in-process state in the plugin instance. That is honest only
 * because the host is single-replica (the chart's
 * `ax-next.validateHostReplicas` refuses more), and it is per user because
 * credential resolution is per user: the caller's own key, then the global
 * one, then env — so one person can be paused while another is not.
 */
export const MEMORY_STATUS_HOOK = 'memory:status';

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
 * (deleted in TASK-608) made on 2026-09-14, and the same model, which is the one every number in
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
 * deadline, and GLM reasons by DEFAULT: `@ax/memory-strata` (since deleted,
 * TASK-608) measured p50 ~3.4s
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
  // The read-only display coarsening of provenance (TASK-526). Refused like
  // provenance so a caller setting it learns it did nothing.
  'savedBy',
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
 * reaches a caller only as the two-value `savedBy` display coarsening, and
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
  /**
   * Engine-side only. Never forwarded verbatim to a caller — the recall
   * handler consumes it to derive the per-answer {@link MemoryStatement.conversation}
   * ordinal and drops the raw id. A non-string value here is treated as
   * absent, not thrown on: this is a hint the product layer derives from,
   * not a contract field it validates.
   */
  conversationId?: string;
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
   * Extraction DURING a conversation (TASK-625): a pass after an idle pause
   * (`idleMs`, default 2 min) or every `everyUserTurns` completed user turns
   * (default 4), whichever comes first, and a final pass at `chat:end`.
   * Active only when the host also has `conversations:get` and `storage:*`
   * (see `incremental.ts`); otherwise, and with `false`, memory is extracted
   * at `chat:end` only, as before.
   */
  incremental?: IncrementalConfig | false;
  /**
   * Sizing for the always-injected block (design §4.1). Every field defaults;
   * see `augment.ts`'s `DEFAULTS`.
   */
  block?: MemoryBlockConfig;
  exports?: MemoryExportConfig;
  rules?: boolean;
}

const DEFAULT_MAX_RECALL_LIMIT = 100;

function resolveIncrementalConfig(
  value: MemoryPluginConfig['incremental'],
): { idleMs: number; everyUserTurns: number } | undefined {
  if (value === false) return undefined;
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'incremental must be an object or false when set',
    });
  }
  const idleMs = value?.idleMs ?? DEFAULT_IDLE_MS;
  if (!Number.isFinite(idleMs) || idleMs < 1) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `incremental.idleMs must be a positive number (got ${String(value?.idleMs)})`,
    });
  }
  const everyUserTurns = value?.everyUserTurns ?? DEFAULT_EVERY_USER_TURNS;
  if (!Number.isInteger(everyUserTurns) || everyUserTurns < 1) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `incremental.everyUserTurns must be a positive integer (got ${String(value?.everyUserTurns)})`,
    });
  }
  return { idleMs, everyUserTurns };
}

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
 * Wired by `presets/memory` (design §10.4: its OWN preset with its own
 * canary). §10.4 also kept `presets/k8s` on `@ax/memory-strata` — one memory
 * plugin per preset, so invariant 4 held trivially — until TASK-576 made this
 * the default and TASK-608 deleted Strata. It is now the only memory plugin.
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

  const incrementalCfg = resolveIncrementalConfig(config.incremental);

  // Resolved ONCE, at construction, so a malformed ref throws HERE rather than
  // degrading on every turn: an unparseable model ref is a static
  // misconfiguration and there is no turn at which it starts working. It also
  // has to be resolved before the manifest is built, because the provider hook
  // it derives is what the manifest declares.
  const memoryOpsModel = config.memoryOpsModel ?? DEFAULT_MEMORY_OPS_MODEL;
  const parsedMemoryOps = parseModelRef(memoryOpsModel);
  const memoryOpsHook = `llm:call:${parsedMemoryOps.provider}`;

  if (config.rules !== undefined && typeof config.rules !== 'boolean') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `rules must be a boolean when set (got ${typeof config.rules})`,
    });
  }

  const exportsCfg = config.exports;
  if (
    exportsCfg !== undefined &&
    (exportsCfg === null || typeof exportsCfg !== 'object' || Array.isArray(exportsCfg))
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'exports must be an object when set',
    });
  }
  if (exportsCfg?.volume !== undefined) validateVolumeConfig(exportsCfg.volume);
  let exporterRef: ReturnType<typeof createMemoryExporter> | undefined;
  let schedulerRef: IncrementalScheduler | undefined;
  // userIds whose last observer LLM call failed for want of a credential.
  // Per plugin INSTANCE (not module-global) so two instances never share it.
  // Set by the observer's missing-credential catch; cleared only by an
  // observer LLM call that resolves — a skipped run proves nothing, and a
  // 504 says nothing about the credential either way.
  const pausedUsers = new Set<string>();

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [
        MEMORY_RECALL_HOOK,
        MEMORY_REMEMBER_HOOK,
        MEMORY_FORGET_HOOK,
        MEMORY_STATUS_HOOK,
        SYSTEM_PROMPT_AUGMENT_HOOK,
        MEMORY_RECALL_TOOL_HOOK,
        MEMORY_NOTE_TOOL_HOOK,
        ...(exportsCfg !== undefined ? [MEMORY_EXPORT_FLUSH_HOOK] : []),
        ...(exportsCfg?.volume !== undefined ? ['sandbox:memory-mounts'] : []),
        ...(config.rules === true ? [RULES_READ_HOOK, RULES_WRITE_HOOK] : []),
      ],
      // Hard dependencies, all five — plus the export projection's four when
      // `exports` is configured (TASK-494): this plugin has nothing to fall
      // back on. A memory surface with no store behind it cannot degrade into
      // anything honest — it can only answer "no memories" to a question it
      // never asked anyone. Failing at boot with `missing-service` is the
      // outcome that gets noticed.
      calls: [
        FACTS_RECALL_HOOK,
        FACTS_RECORD_HOOK,
        FACTS_SUPERSEDE_HOOK,
        'tool:register',
        AGENTS_RESOLVE_HOOK,
        ...(exportsCfg !== undefined
          ? [FACTS_SCAN_HOOK, 'workspace:list', 'workspace:read', 'workspace:apply']
          : config.rules === true
            ? ['workspace:read', 'workspace:apply']
            : []),
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
      // implementations (design §10.4). This plugin provides it only with
      // `rules: true`, so a preset can legitimately load `@ax/memory` without one —
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
        // TASK-625. All three are needed together; without any one of them
        // the plugin keeps the chat:end-only path it always had.
        ...(incrementalCfg !== undefined
          ? [CONVERSATIONS_GET_HOOK, STORAGE_GET_HOOK, STORAGE_SET_HOOK].map((hook) => ({
              hook,
              degradation:
                'memory is extracted only at chat:end, from that session\'s own messages, with no source turn on the stored statements; nothing is extracted during a conversation',
            }))
          : []),
      ],
      subscribes: [CHAT_END_HOOK, ...(incrementalCfg !== undefined ? [CHAT_TURN_END_HOOK] : [])],
    },

    async init({ bus }: { bus: HookBus }) {
      const exporter =
        exportsCfg === undefined ? undefined : createMemoryExporter(bus, exportsCfg);
      exporterRef = exporter;
      const onFactsChanged = (ctx: AgentContext): void => {
        exporter?.schedule(ctx);
      };

      if (exporter !== undefined) {
        bus.registerService<Record<string, never>, { changed: boolean }>(
          MEMORY_EXPORT_FLUSH_HOOK,
          PLUGIN_NAME,
          async (ctx) => exporter.flush(ctx),
        );
      }
      if (exportsCfg?.volume !== undefined && exporter !== undefined) {
        const volume = exportsCfg.volume;
        bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
          'sandbox:memory-mounts',
          PLUGIN_NAME,
          async (ctx, input) => {
            const owner = input?.owner;
            if (
              owner === null ||
              typeof owner !== 'object' ||
              typeof owner.agentId !== 'string' ||
              owner.agentId.trim() === '' ||
              typeof owner.userId !== 'string' ||
              owner.userId.trim() === ''
            ) {
              throw invalid('owner must carry an agentId and userId', 'sandbox:memory-mounts');
            }
            const ownerCtx: AgentContext = {
              ...ctx,
              agentId: owner.agentId,
              userId: owner.userId,
            };
            await resolveMemoryAccess(bus, ownerCtx);
            await exporter.flush(ownerCtx);
            return { mounts: [memoryMountSpec(owner.agentId, volume)] };
          },
        );
      }

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
          // And its ELEMENTS, the same step `toMemoryStatement` takes for
          // `statements` rows: validating the array but not what is in it
          // would hand a caller `[42]` or `[null]` on a payload typed
          // `string[]`. An unreadable element is thrown on, not dropped (a
          // dropped element is a silently discarded degradation signal) and
          // not coerced (`String(null)` is a flag the engine never raised).
          // The message is a static literal: the element is engine-supplied
          // and never interpolated. Only the TYPE is checked — the vocabulary
          // is deliberately open, so a flag a newer engine learned to raise
          // still passes through verbatim below. `for...of`, not `every`:
          // `every` skips a hole, and the spread below would then hand the
          // caller that hole as a real `undefined`.
          for (const flag of result.degraded ?? []) {
            if (typeof flag !== 'string') {
              throw new PluginError({
                code: 'invalid-return',
                plugin: PLUGIN_NAME,
                hookName: MEMORY_RECALL_HOOK,
                message: `${FACTS_RECALL_HOOK} returned a non-string degraded flag; a degradation signal we cannot read is not one we may hand a caller`,
              });
            }
          }

          for (const row of result.statements) {
            toMemoryStatement(row);
          }
          const activeOnly = input.activeOnly !== false;
          // Each subject's slot chains read whole (closed rows included): the
          // replaced row and the correction may sit outside the retrieved
          // pool while the stale re-mention ranks inside it.
          const readSlotGroup = async (
            seed: readonly EngineFactRecord[] = result.statements,
          ): Promise<EngineFactRecord[]> => {
            const abouts = [
              ...new Set(
                seed
                  .filter((row) => typeof row.slot === 'string' && row.slot !== '')
                  .map((row) => row.about),
              ),
            ];
            const group: EngineFactRecord[] = [];
            for (const about of abouts) {
              const slotRows = requireEngineResult(
                await bus.call<unknown, EngineRecallOutput | null>(FACTS_RECALL_HOOK, ctx, {
                  limit: 200,
                  ...memoryReadScope(access),
                  about,
                  slots: [...SLOTS],
                  activeOnly: false,
                }),
                MEMORY_RECALL_HOOK,
                FACTS_RECALL_HOOK,
              );
              if (Array.isArray(slotRows.statements)) group.push(...slotRows.statements);
            }
            return group;
          };
          let page: EngineFactRecord[];
          // History only: active rows the equivalent active read would hide.
          let overridden = new Set<EngineFactRecord>();
          if (input.profile === true && activeOnly) {
            // The chains (closed rows included) let the pick recognise a
            // re-mention of a replaced value (TASK-602).
            page = selectProfileRows(
              result.statements,
              limit,
              hasContestedSlot(result.statements) ? await readSlotGroup() : [],
            );
          } else if (activeOnly) {
            // §3.4 on the read path: a correction survives the next chat
            // mention. A lower-provenance row that merely restates a value the
            // person replaced is the stale value coming back, not news — see
            // `dropRementionedSlotRows`.
            page = dropRementionedSlotRows(result.statements, await readSlotGroup()).slice(0, limit);
          } else {
            // History shows every row, but says which active ones the active
            // read hides — otherwise an outranked row looks current and a
            // person edits the one the agent never uses. The same selection
            // functions as the active branches decide, so the mark and the
            // hide cannot drift.
            page = result.statements.slice(0, limit);
            if (input.profile === true) {
              // The winners come from the ACTIVE slot rows read on their own,
              // not from this page: the page is recency-ordered and capped,
              // and an old human correction (never closed) is exactly the row
              // that falls off it — which would crown a newer outranked row.
              const activeRows = requireEngineResult(
                await bus.call<unknown, EngineRecallOutput | null>(FACTS_RECALL_HOOK, ctx, {
                  limit: 200,
                  ...memoryReadScope(access),
                  about: rewriteSpeaker(SPEAKER_SUBJECT, ownerUserId),
                  slots: [...SLOTS],
                  activeOnly: true,
                }),
                MEMORY_RECALL_HOOK,
                FACTS_RECALL_HOOK,
              );
              // Refused, not coerced: an empty winner set would mark every
              // active row overridden — nonsense rendered as an answer, the
              // same lie the primary read's array check refuses.
              if (!Array.isArray(activeRows.statements)) {
                throw new PluginError({
                  code: 'invalid-return',
                  plugin: PLUGIN_NAME,
                  hookName: MEMORY_RECALL_HOOK,
                  message: `${FACTS_RECALL_HOOK} returned a non-array statements; memory cannot say which profile rows are in effect`,
                });
              }
              // Same chains the active profile read passes, so the mark and
              // the pick cannot drift.
              const chain = hasContestedSlot(activeRows.statements)
                ? await readSlotGroup(activeRows.statements)
                : [];
              const winners = new Set(
                selectProfileRows(activeRows.statements, Number.MAX_SAFE_INTEGER, chain).map(
                  (row) => row.id,
                ),
              );
              overridden = new Set(
                result.statements.filter(
                  (row) =>
                    row.until === undefined &&
                    typeof row.slot === 'string' &&
                    row.slot !== '' &&
                    !winners.has(row.id),
                ),
              );
            } else {
              overridden = rementionedSlotRows(result.statements, await readSlotGroup());
            }
          }
          const visibleIds = new Set(page.map((row) => row.id));
          const ownSubject = rewriteSpeaker(SPEAKER_SUBJECT, ownerUserId);

          // Per-answer conversation ordinals (design doc "Signal" section,
          // TASK-611): a copy of `page` sorted chronologically the same way
          // `renderEvidenceTable` orders rows (`when` asc, then `id` asc), so
          // the numbers read #1, #2, ... top to bottom in the rendered
          // evidence table. One ordinal per DISTINCT non-empty string
          // `conversationId`, assigned in first-appearance order over that
          // chronological pass — not over `page`'s own (recency) order. A
          // non-string `conversationId` is treated as absent, never thrown
          // on: this is a derived display hint, not a validated contract
          // field. The raw id is never put on the ordinal map's values or on
          // any output payload.
          const conversationOrdinals = new Map<string, number>();
          for (const row of [...page].sort(
            (a, b) => a.when.localeCompare(b.when) || a.id.localeCompare(b.id),
          )) {
            if (typeof row.conversationId === 'string' && row.conversationId !== '') {
              if (!conversationOrdinals.has(row.conversationId)) {
                conversationOrdinals.set(row.conversationId, conversationOrdinals.size + 1);
              }
            }
          }

          return {
            statements: page.map((row) => {
              const mapped = toMemoryStatement(row);
              const conversation =
                typeof row.conversationId === 'string'
                  ? conversationOrdinals.get(row.conversationId)
                  : undefined;
              const savedBy =
                row.provenance === 'human'
                  ? ('person' as const)
                  : row.provenance === 'agent'
                    ? ('agent' as const)
                    : undefined;
              return {
                ...mapped,
                // Another person's speaker subject is `user:<their id>`; a
                // caller is never handed that id, only that it is someone else.
                aboutText:
                  row.about === ownSubject
                    ? 'you'
                    : row.about.startsWith(`${SPEAKER_SUBJECT}:`)
                      ? 'a teammate'
                      : row.about.replace(/_/g, ' '),
                // No until suffix: `closure` owns closure, and a "→ superseded"
                // beside a Forgotten badge is the contradiction TASK-526 fixed.
                whenText: formatEvidenceWhen({ when: mapped.when }, asOf),
                ...(savedBy !== undefined ? { savedBy } : {}),
                ...(conversation !== undefined ? { conversation } : {}),
                ...(row.until !== undefined
                  ? { closure: row.closedBy === undefined ? ('forgotten' as const) : ('replaced' as const) }
                  : overridden.has(row)
                    ? { closure: 'overridden' as const }
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
      // memory:remember — the human correction write. Provenance: human.
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
                  // (a canary, an admin probe) or is a routine run
                  // (`conversationOf`, TASK-616).
                  ...conversationField(ctx),
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
          onFactsChanged(ctx);
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

          onFactsChanged(ctx);
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
      // observer's slowness cost nothing. (Since TASK-551 the orchestrator's
      // SYNTHESIZED `chat:end` fires bound each subscriber at 30 s, and since
      // TASK-555 so does the runner-reported one @ax/ipc-core fires. Neither
      // changes this: an awaited extraction would either hold the turn open
      // or be cut off mid-flight and skipped.)
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
      const observeCfg: ObserveConfig = {
        memoryOpsHook,
        model: parsedMemoryOps.modelId,
        observerTimeoutMs,
        onFactsChanged,
        pausedUsers,
      };
      const scheduler =
        incrementalCfg === undefined
          ? undefined
          : createIncrementalScheduler({
              ...incrementalCfg,
              runPass: (ctx, trigger) => runConversationPass(bus, ctx, trigger, observeCfg),
              ...(config.onObserverDetached !== undefined
                ? { onDetached: config.onObserverDetached }
                : {}),
            });
      schedulerRef = scheduler;

      bus.subscribe<{ outcome?: unknown }>(CHAT_END_HOOK, PLUGIN_NAME, async (ctx, payload) => {
        // Fire-and-forget. `void` rather than `await`, and the whole body is
        // already non-throwing, so there is nothing here for `fire` to log.
        //
        // NOTE this deliberately does NOT skip `ctx.source === 'routine'` the
        // way `@ax/memory-strata`'s observer did (deleted in TASK-608). Strata's
        // memory was the
        // agent's own episodic tree, which a scheduled fire would have polluted
        // with its own internal work. This store is owner-scoped statements,
        // and design §3.2 settles the case explicitly: "Conversations with no
        // live person — a routine run — carry the routine owner's id", which
        // is a rule for how a routine's statements are STORED, not a reason
        // not to store them. `owner.ts` says the same in as many words and
        // does not branch on `source`.
        //
        // What `source` DOES change is attribution (TASK-616): a routine
        // turn's rows are stored with no conversation, because a routine's
        // hidden per-fire conversation is not one the person had, and
        // counting it let skill-reflection's own passes inflate the
        // distinct-conversation gate. See `conversation.ts`.
        //
        // TASK-625: when this host extracts incrementally, `chat:end` is the
        // FINAL pass over the canonical transcript's remaining turns — queued
        // behind any pass still running for the conversation, and whatever
        // the outcome kind, because the turns a crashed session persisted are
        // real. Otherwise it is the one extraction, over its own messages.
        const conversationId = ctx.conversationId;
        if (
          scheduler !== undefined &&
          typeof conversationId === 'string' &&
          conversationId !== '' &&
          canExtractIncrementally(bus)
        ) {
          scheduler.onChatEnd(ctx as AgentContext & { conversationId: string });
          return undefined;
        }
        const work = observeChatEnd(bus, ctx, payload, observeCfg).catch(() => {
          // Unreachable: `observeChatEnd` catches everything and logs it.
          // Present because a detached promise that CAN reject is an
          // unhandled rejection, and "unreachable" is a claim about today's
          // code rather than tomorrow's.
        });
        config.onObserverDetached?.(work);
        return undefined;
      });

      // ---------------------------------------------------------------
      // chat:turn-end — incremental extraction triggers (TASK-625).
      // ---------------------------------------------------------------
      //
      // Same posture as `chat:end`: returns at once, never throws, and every
      // pass is detached (see `incremental.ts`). A turn never waits on memory.
      if (scheduler !== undefined) {
        const sched = scheduler;
        bus.subscribe<{ role?: unknown; reqId?: unknown }>(
          CHAT_TURN_END_HOOK,
          PLUGIN_NAME,
          async (ctx, payload) => {
            try {
              if (canExtractIncrementally(bus)) sched.onTurnEnd(ctx, payload);
            } catch {
              // `onTurnEnd` only touches in-memory state and a timer; there is
              // nothing to report and no turn to fail.
            }
            return undefined;
          },
        );
      }

      // ---------------------------------------------------------------
      // memory:status — the caller's own "extraction paused" state. The
      // input is ignored: it answers for ctx.userId and nobody else.
      // ---------------------------------------------------------------
      bus.registerService<unknown, MemoryStatusOutput>(
        MEMORY_STATUS_HOOK,
        PLUGIN_NAME,
        async (ctx) => {
          const userId = ctx.userId;
          if (typeof userId === 'string' && userId !== '' && pausedUsers.has(userId)) {
            return { extraction: 'paused', reason: 'missing-credential' };
          }
          return { extraction: 'ok' };
        },
      );

      if (config.rules === true) registerRulesHooks(bus);
      await registerMemoryRecall(bus);
      await registerMemoryNote(bus, onFactsChanged);
    },

    async shutdown() {
      schedulerRef?.shutdown();
      await exporterRef?.shutdown();
    },
  };
}

interface ObserveConfig {
  memoryOpsHook: string;
  model: string;
  observerTimeoutMs: number;
  onFactsChanged?: (ctx: AgentContext) => void;
  pausedUsers: Set<string>;
}

/** What a producer gets: the wired extraction call, the wired write, the owner. */
interface ObserveDeps {
  llmCall: (input: LlmCallInput) => Promise<LlmCallOutput>;
  record: (input: ObserverRecordInput) => Promise<{ records?: Array<{ id?: unknown }> } | null>;
  ownerUserId: string;
  userId: string | undefined;
}

/**
 * Run one observation. **Never throws** — see the subscriber's comment for
 * why that is load-bearing rather than tidy.
 *
 * Shared by the legacy `chat:end` path and the incremental passes
 * (TASK-625): access, the provider check, the wrapped provider and engine
 * calls, the paused-state bookkeeping and the failure events live here once.
 * `produce` supplies only WHAT is extracted. Resolves `true` when the
 * producer returned (whatever it reported) and `false` when anything threw —
 * the incremental pass keeps its cursor on `false`, so the turns are tried
 * again.
 */
async function observe(
  bus: HookBus,
  ctx: AgentContext,
  cfg: ObserveConfig,
  trigger: PassTrigger | undefined,
  produce: (deps: ObserveDeps) => Promise<ObserverResult | undefined>,
): Promise<boolean> {
  const userId = typeof ctx.userId === 'string' && ctx.userId !== '' ? ctx.userId : undefined;
  try {
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
        ...(trigger !== undefined ? { trigger } : {}),
      });
      return false;
    }

    const result = await produce({
      llmCall: async (input: LlmCallInput) => {
        const out = await bus.call<LlmCallInput, LlmCallOutput>(cfg.memoryOpsHook, ctx, {
          ...input,
          // Applied HERE rather than at the call site, so a future memory
          // operation cannot forget it.
          reasoningEffort: MEMORY_OPS_REASONING,
        });
        // The provider answered, so a credential resolved for this user:
        // whatever paused them is fixed. Only a RESOLVED call may clear it.
        if (userId !== undefined) cfg.pausedUsers.delete(userId);
        return out;
      },
      record: async (input: ObserverRecordInput) => {
        await resolveMemoryAccess(bus, ctx);
        const out = await bus.call<ObserverRecordInput, { records?: Array<{ id?: unknown }> } | null>(
          FACTS_RECORD_HOOK,
          ctx,
          input,
        );
        cfg.onFactsChanged?.(ctx);
        return out;
      },
      ownerUserId,
      userId,
    });

    if (result !== undefined) logObserverResult(ctx, result, trigger);
    return true;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // A missing credential will not fix itself and costs every turn until
    // somebody stores a key, so it gets its own event at `error` volume —
    // the "memory paused" state. Everything else keeps the path's `warn`.
    if (isMissingCredential(err)) {
      if (userId !== undefined) cfg.pausedUsers.add(userId);
      ctx.logger.error(NO_CREDENTIAL_EVENT, {
        err: error,
        agentId: ctx.agentId,
        path: 'observer',
        ...(trigger !== undefined ? { trigger } : {}),
        ...noCredentialFields(),
      });
      return false;
    }
    ctx.logger.warn(memoryFailureEvent(err, OBSERVER_FAILED_EVENT), {
      err: error,
      agentId: ctx.agentId,
      reason: 'observer-threw',
      ...(trigger !== undefined ? { trigger } : {}),
    });
    return false;
  }
}

/** The legacy path: one extraction over `chat:end`'s own messages. */
async function observeChatEnd(
  bus: HookBus,
  ctx: AgentContext,
  payload: { outcome?: unknown } | undefined,
  cfg: ObserveConfig,
): Promise<void> {
  // A terminated outcome (a `chat:start` veto, a runner crash, a timeout)
  // carries no transcript, and a malformed payload carries nothing we can
  // read. Both skip silently: neither is a failure of the memory path.
  const outcome = payload?.outcome;
  if (outcome === null || typeof outcome !== 'object') return;
  const { kind, messages } = outcome as { kind?: unknown; messages?: unknown };
  if (kind !== 'complete' || !Array.isArray(messages) || messages.length === 0) return;

  await observe(bus, ctx, cfg, undefined, ({ llmCall, record, ownerUserId }) =>
    runObserver({
      messages: messages as UntrustedMessage[],
      llmCall,
      record,
      ownerUserId,
      // The batch identity keeps the real conversation; the rows are
      // attributed per `conversationOf` (a routine run is not a
      // conversation the person had — TASK-616).
      conversationId: ctx.conversationId,
      statementConversationId: conversationOf(ctx),
      model: cfg.model,
      now: new Date(),
      timeoutMs: cfg.observerTimeoutMs,
    }),
  );
}

/** How many dialogue turns before a pass's first new turn it may see. */
const CONTEXT_TURNS = 2;

/**
 * One incremental pass over a conversation's canonical transcript (TASK-625).
 *
 * 1. A paused user is skipped before anything is read — except at
 *    `chat:end`, which always tries, because only a resolved call may clear
 *    the pause.
 * 2. Read the cursor and the transcript. The new turns are those at or after
 *    the cursor, up to and including the LAST assistant turn: a user message
 *    with no reply yet is not a completed turn, and taking it now would split
 *    it from its answer. `chat:end` takes everything — the session is over.
 * 3. Extract with up to {@link CONTEXT_TURNS} earlier dialogue turns in view,
 *    record under the range key, then move the cursor past every turn the
 *    range spans (tool turns included).
 *
 * The cursor moves on every outcome the producer RETURNS — recorded,
 * skipped, and also a timeout or schema failure, which drop the batch exactly
 * as the `chat:end` path always has. It stays put when anything throws (the
 * transcript read, the provider, the engine), so those turns are retried by
 * the next pass under the same key.
 */
async function runConversationPass(
  bus: HookBus,
  ctx: AgentContext & { conversationId: string },
  trigger: PassTrigger,
  cfg: ObserveConfig,
): Promise<void> {
  const conversationId = ctx.conversationId;
  await observe(bus, ctx, cfg, trigger, async ({ llmCall, record, ownerUserId, userId }) => {
    if (trigger !== 'chat-end' && userId !== undefined && cfg.pausedUsers.has(userId)) {
      return { kind: 'skipped', reason: 'paused' };
    }
    if (userId === undefined) {
      throw new Error('an incremental pass needs the caller userId to read the transcript');
    }

    const cursor = await readCursor(bus, ctx, conversationId);
    const read = await bus.call<{ conversationId: string; userId: string }, { turns?: unknown } | null>(
      CONVERSATIONS_GET_HOOK,
      ctx,
      { conversationId, userId },
    );
    const rawTurns = Array.isArray(read?.turns) ? (read.turns as unknown[]) : [];
    const dialogue = filterTranscriptTurns(rawTurns);

    let fresh = dialogue.filter((turn) => turn.turnIndex >= cursor);
    if (trigger !== 'chat-end') {
      let lastAssistant = -1;
      fresh.forEach((turn, i) => {
        if (turn.role === 'assistant') lastAssistant = i;
      });
      fresh = fresh.slice(0, lastAssistant + 1);
    }
    const last = fresh[fresh.length - 1];
    if (last === undefined) return { kind: 'skipped', reason: 'no-new-turns' };
    const context = dialogue.filter((turn) => turn.turnIndex < cursor).slice(-CONTEXT_TURNS);

    const result = await runTurnObserver({
      context,
      fresh,
      llmCall,
      record,
      ownerUserId,
      // Batch identity: the real conversation. Stored attribution: per
      // `conversationOf`, so a routine turn's rows carry none (TASK-616).
      conversationId,
      statementConversationId: conversationOf(ctx),
      model: cfg.model,
      now: new Date(),
      timeoutMs: cfg.observerTimeoutMs,
    });
    await writeCursor(bus, ctx, conversationId, last.turnIndex + 1);
    return result;
  });
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
function logObserverResult(
  ctx: AgentContext,
  result: ObserverResult,
  trigger?: PassTrigger,
): void {
  // `trigger` names which incremental pass ran (TASK-625); absent on the
  // legacy `chat:end` path, so its lines are unchanged.
  const base = {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    ...(trigger !== undefined ? { trigger } : {}),
  };
  switch (result.kind) {
    case 'skipped':
      // `debug`: an ordinary turn with nothing durable in it is the common
      // case, not a problem.
      ctx.logger.debug(OBSERVER_RUN_EVENT, {
        ...base,
        outcome: 'skipped',
        reason: result.reason,
        ...('selfReports' in result ? { selfReports: result.selfReports } : {}),
        ...('contextOnly' in result ? { contextOnly: result.contextOnly } : {}),
      });
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
        // The agent's own "I have no rules" style statements, dropped
        // (TASK-612). Informational; not a failure.
        selfReports: result.selfReports,
        // Facts only a context turn supported, dropped (TASK-625). Only an
        // incremental pass has context turns.
        ...(trigger !== undefined ? { contextOnly: result.contextOnly } : {}),
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
 *    IN. The recall handler derives the read-only `savedBy` display field from
 *    it; the column itself never leaves.
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
