import type {
  AgentContext,
  AgentOutcome,
  HookBus,
  Plugin,
  ReasoningEffort,
  WorkspaceListInput,
  WorkspaceListOutput,
} from '@ax/core';
import { parseModelRef } from '@ax/core';
import {
  AGENT_TIER_MEMORY_ROOT,
  agentTierAvailable,
  flushAgentTier,
  hydrateAgentTier,
  scratchRelToTierPath,
  type HydratedTier,
} from './agent-tier-sync.js';
import {
  isMissingCredential,
  noCredentialFields,
  NO_CREDENTIAL_EVENT,
} from './llm-failure.js';
import { join } from 'node:path';
import {
  BOOTSTRAP_SEED_FILES,
  bootstrapMemoryTree,
  isPlaceholderAgentFile,
  readRegularFile,
} from './bootstrap.js';
import { systemFile } from './paths.js';
import { composeIdentityFromFiles, composeIdentityFromTier } from './compose-identity.js';
import { runConsolidation, type ConsolidationInput, type ConsolidationResult } from './consolidator.js';
import { createDebouncer, type Debouncer } from './debounce.js';
import { registerInject } from './inject.js';
import { registerRulesHooks } from './rules-hooks.js';
import { makeLlmDensifier, type MapDensifier } from './map.js';
import { runObserver, type LlmCallFn } from './observer.js';
import { makeStageBNamer, type StageBNamer } from './rollup.js';
import type { OrchestratorClient } from './orchestrator.js';
import { registerReindexer } from './reindex.js';
import { raceTimeout } from './timeout.js';
import { registerMemorySearch } from './tools/memory-search.js';
import { registerMemoryReadSection } from './tools/memory-read-section.js';
import { registerMemoryNote } from './tools/memory-note.js';

const PLUGIN_NAME = '@ax/memory-strata';
const PLUGIN_VERSION = '0.0.0';

const DEFAULT_OBSERVER_TIMEOUT_MS = 30_000;
/** Provider hook for the FIXED-tier internal calls (Stage-B rollup naming).
 *  Since 2026-09-14 the Observer and map densifier are ALSO fixed-tier — see
 *  {@link DEFAULT_MEMORY_OPS_MODEL} — but they derive their hook from that
 *  ref's provider rather than reading this, so an operator can move the memory
 *  role without moving the rollup namer. */
export const DEFAULT_LLM_HOOK = 'llm:call:openrouter';
const DEFAULT_CONSOLIDATOR_DEBOUNCE_MS = 5_000;
const DEFAULT_CONSOLIDATOR_TIMEOUT_MS = 60_000;
const DEFAULT_MAP_DENSIFY_TIMEOUT_MS = 30_000;
/** Cheap in-stack extraction tier for Stage-B rollup naming (TASK-201). Fixed —
 *  NOT the agent's model — so the pass stays O(1 cheap call)/dirty pass with no
 *  new egress (design §D2). BARE id: it is routed by {@link DEFAULT_LLM_HOOK},
 *  not parsed, so `z-ai/` here is part of the vendor slug rather than a
 *  provider prefix (the bare-vs-ref trap in
 *  `docs/plans/2026-09-11-model-roles-design.md`). */
const DEFAULT_ROLLUP_STAGE_B_MODEL = 'z-ai/glm-5.3-flash:nitro';
const DEFAULT_ROLLUP_STAGE_B_TIMEOUT_MS = 30_000;

/**
 * The model every MEMORY OPERATION runs on: observer extraction and map
 * densification (and, via {@link DEFAULT_ROLLUP_STAGE_B_MODEL} +
 * {@link DEFAULT_LLM_HOOK}, rollup naming).
 *
 * A `provider/model-id` REF — `parseModelRef` splits on the first slash, so the
 * provider is `openrouter` and the model id is `z-ai/glm-5.3-flash:nitro`. A
 * two-slash value is expected here.
 *
 * **This replaces inheriting the calling agent's model.** Until 2026-09-14 the
 * Observer and densifier routed to `llm:call:<the agent's provider>` with the
 * agent's own model id, so memory quality and cost tracked whatever model the
 * user happened to have selected for chat, and a deployment could not state
 * what its memory pipeline ran on. Memory extraction is a fixed internal job,
 * not a user-facing one; pinning it makes it answerable.
 *
 * Paired with {@link MEMORY_OPS_REASONING} — see there for why that is not
 * optional for this model.
 */
export const DEFAULT_MEMORY_OPS_MODEL = 'openrouter/z-ai/glm-5.3-flash:nitro';

/**
 * Reasoning level for every memory operation.
 *
 * `minimal` because these are extraction and summarization jobs with a hard
 * timeout, and GLM reasons by DEFAULT: measured p50 ~3.4s with the field absent
 * versus ~865ms with it. The observer's deadline is
 * {@link DEFAULT_OBSERVER_TIMEOUT_MS} and the densifier's is
 * {@link DEFAULT_MAP_DENSIFY_TIMEOUT_MS}; blowing either degrades silently (a
 * dropped observation, a map entry that falls back to its raw summary), which
 * is precisely the failure mode that hides a slow model.
 *
 * Applied by {@link buildMemoryOpsLlmCall} to every call on this path, rather
 * than at each call site, so a new memory operation cannot forget it.
 */
const MEMORY_OPS_REASONING: ReasoningEffort = 'minimal';

export interface MemoryStrataConfig {
  /**
   * Bus hook to call for the FIXED-tier internal LLM round-trips (Stage-B
   * rollup naming). Default `llm:call:anthropic` matches the only registered
   * host-side LLM provider today. A preset that registers a different provider
   * for that fixed tier overrides this.
   *
   * NOT used by the agent-model-derived paths (Observer, map densifier): those
   * route to `llm:call:<provider>` where `<provider>` is the first segment of
   * the agent's own `provider/model-id` ref, so an agent on a non-default
   * provider reaches its own provider without any config change.
   */
  llmCallHook?: string;
  /**
   * `provider/model-id` ref for the memory operations (observer extraction, map
   * densification). Default {@link DEFAULT_MEMORY_OPS_MODEL}. Always a REF —
   * the provider half selects the `llm:call:<provider>` hook.
   */
  memoryOpsModel?: string;
  /**
   * Hard deadline for the Observer's LLM call. Per I6, exceeding this
   * drops the run cleanly with no inbox writes. Defaults to 30 s.
   */
  observerTimeoutMs?: number;
  /**
   * Per-agent debounce window for the Consolidator (ms). Multiple chat:end
   * events within this window coalesce into a single consolidation pass.
   * Default 5 000 ms (I10).
   */
  consolidatorDebounceMs?: number;
  /**
   * Hard ceiling on a single consolidation pass (ms). A pass that exceeds
   * this is abandoned cleanly — no partial writes because every doc write
   * is atomic (write-to-temp + rename). Default 60 000 ms (I10).
   */
  consolidatorTimeoutMs?: number;
  /**
   * Whether to LLM-densify `system/map.md` entries during consolidation
   * (TASK-190). Default `true`. When the densifier can't be built (no agent
   * model resolvable) or a call fails, the map degrades to raw doc summaries —
   * so this flag only controls whether we ATTEMPT densification, never whether
   * the map is generated. Set `false` to force the cheap raw-summary map (e.g.
   * a latency-sensitive deployment that doesn't want per-consolidation LLM
   * round-trips).
   */
  mapDensifyEnabled?: boolean;
  /**
   * Hard deadline for a single map-densify LLM round-trip (ms). Mirrors the
   * Observer's I6 timeout posture: a slow call is abandoned and that one doc
   * degrades to its raw summary. Default 30 000 ms.
   */
  mapDensifyTimeoutMs?: number;
  /**
   * Whether to run Stage-B bounded LLM class naming during the rollup pass
   * (TASK-201). Default `true`. When disabled — or when no `llm:call` provider
   * is registered — the rollup pass runs Stage A (deterministic) only, so this
   * flag only controls whether we ATTEMPT the single cheap LLM call over the
   * residue, never whether rollups are produced. Set `false` for a latency- or
   * cost-sensitive deployment that wants the deterministic pass only.
   */
  rollupStageBEnabled?: boolean;
  /**
   * Model id for the Stage-B rollup namer. Default `claude-haiku-4-5` — the cheap
   * in-stack extraction tier (NOT the agent's model), so naming is one cheap call
   * per dirty pass with no new external egress.
   */
  rollupStageBModel?: string;
  /**
   * Hard deadline for the single Stage-B naming call (ms). A slow call is
   * abandoned and the pass keeps its Stage-A rollups (best-effort accelerator).
   * Default 30 000 ms.
   */
  rollupStageBTimeoutMs?: number;
  /**
   * Retrieval mode for the memory_search tool. 'orchestrator' (default) uses
   * the cheap-LLM retrieval planner over system/map.md with a BM25 fallback
   * when an orchestrator client is configured; 'bm25' forces pure BM25 even
   * if a client is present (latency-sensitive surfaces). With no client
   * configured, both modes behave as BM25.
   */
  retrievalMode?: 'orchestrator' | 'bm25';
  /**
   * Optional orchestrator wiring. When the orchestrator can reach a model AND
   * retrievalMode !== 'bm25', memory_search runs the retrieval orchestrator
   * (reads system/map.md + query → load/fts ops) and falls back to BM25 on
   * miss/timeout. Unreachable ⇒ pure BM25.
   *
   * `hook` + `model` is the production wiring: the completion goes through a
   * registered `llm:call:<provider>` hook, so the provider resolves the
   * credential per call (user key → global key → env) and the orchestrator
   * holds no key of its own. It degrades to BM25 on three counts, all normal:
   * no hook configured, no plugin registered for it, or the provider having no
   * credential to resolve.
   *
   * `client` injects a direct fetch client instead and wins over `hook`. That
   * is the bench/eval path — it is how the n=500 spike forced one provider —
   * and it is deliberately NOT how a deployment is configured, because a
   * client carries its own API key and a key needs a way in.
   */
  orchestrator?: {
    client?: OrchestratorClient;
    hook?: string;
    model?: string;
    timeoutMs?: number;
  };
  /**
   * Time source for observer stamps and consolidation passes. Bench-only
   * seam (e2e temporal fidelity — the harness replays sessions whose fiction
   * happened on corpus dates, not today). Production omits it: real time.
   */
  nowFn?: () => Date;
  /**
   * Test-only seam — captures the per-plugin Debouncer so tests can
   * call `flush()` deterministically. NOT for production use.
   *
   * `onConsolidationSettleReady` hands tests a `settle(agentId)` fn that
   * awaits the agent's most-recent underlying `runConsolidation` promise —
   * the REAL fs work, not the bounded `raceTimeout` wrapper that
   * `Debouncer.flush()` resolves on. The consolidator detaches its fs work
   * (it keeps running past `consolidatorTimeoutMs`), so `flush()` alone is
   * NOT a complete settle signal; a test that asserts on inbox/doc state
   * must `await settle(agentId)` after `flush()` or it races the detached
   * work. Production code never calls `settle`.
   */
  testHooks?: {
    onDebouncerCreated?(debouncer: Debouncer): void;
    onConsolidationSettleReady?(settle: (agentId: string) => Promise<void>): void;
    /**
     * Test-only seam — hands tests a `settle(agentId)` fn that awaits the
     * agent's most-recent Observer run (the `chat:end` fire-and-forget
     * `kickOffObserver` promise). Per I6 the Observer is DELIBERATELY not
     * awaited on the bus (chat:end must not block on a ~30 s LLM call), so a
     * test that asserts on inbox state after `chat:end` must `await
     * settle(agentId)` instead of sleeping a fixed window — a wall-clock sleep
     * races the detached `agents:resolve → llm:call → fs-write` chain under
     * parallel load (the ENOENT-scandir flake this seam fixes). Resolves
     * immediately if no Observer ever ran. Production code never calls `settle`.
     */
    onObserverSettleReady?(settle: (agentId: string) => Promise<void>): void;
    /**
     * Test-only override for the consolidation pass. When provided, the
     * plugin calls THIS instead of the real `runConsolidation`. This lets
     * timeout/serialization tests drive a consolidation whose duration is
     * controlled by fake timers (`vi.useFakeTimers()`), so the
     * `raceTimeout` deadline fires DETERMINISTICALLY rather than racing the
     * real fs work under full-suite load (the #146/TASK-5 flake class).
     * Production code never sets this — the real `runConsolidation` runs.
     */
    runConsolidation?(input: ConsolidationInput): Promise<ConsolidationResult>;
  };
}

interface AgentResolveResponse {
  agent: { model: string };
}

/**
 * `chat:start` payload — fired by the orchestrator at the top of each
 * agent:invoke. We don't read any field; just use this as a "the agent
 * is about to do work" signal to seed the memory tree.
 */
type ChatStartPayload = Record<string, unknown>;

interface ChatEndPayload {
  outcome: AgentOutcome;
}

/**
 * Build the @ax/memory-strata plugin (Phase 1: Level 0 hot tier +
 * Level 1 Observer).
 *
 * Bootstrap fires on chat:start because no agent:created hook exists
 * yet (plan deviation D4); idempotent so repeated chats don't clobber
 * accumulated memory.
 *
 * Observer fires on chat:end. Per I6 it returns to the bus IMMEDIATELY
 * — the actual extraction runs in the background, bounded by the
 * configured timeout. A late LLM call's result is discarded.
 */
export function createMemoryStrataPlugin(cfg: MemoryStrataConfig = {}): Plugin {
  const llmCallHook = cfg.llmCallHook ?? DEFAULT_LLM_HOOK;
  const memoryOpsModel = cfg.memoryOpsModel ?? DEFAULT_MEMORY_OPS_MODEL;
  // Provider hook the memory-ops role routes to, resolved ONCE at manifest-build
  // time so it can be declared as a hard dependency (see `calls` below). A
  // malformed ref throws HERE, at construction, rather than degrading per turn:
  // an unparseable model ref is a static misconfiguration and there is no turn
  // at which it starts working.
  const memoryOpsHook = `llm:call:${parseModelRef(memoryOpsModel).provider}`;
  const observerTimeoutMs = cfg.observerTimeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS;
  const consolidatorDebounceMs = cfg.consolidatorDebounceMs ?? DEFAULT_CONSOLIDATOR_DEBOUNCE_MS;
  const consolidatorTimeoutMs = cfg.consolidatorTimeoutMs ?? DEFAULT_CONSOLIDATOR_TIMEOUT_MS;
  const mapDensifyEnabled = cfg.mapDensifyEnabled ?? true;
  const mapDensifyTimeoutMs = cfg.mapDensifyTimeoutMs ?? DEFAULT_MAP_DENSIFY_TIMEOUT_MS;
  const rollupStageBEnabled = cfg.rollupStageBEnabled ?? true;
  const rollupStageBModel = cfg.rollupStageBModel ?? DEFAULT_ROLLUP_STAGE_B_MODEL;
  const rollupStageBTimeoutMs = cfg.rollupStageBTimeoutMs ?? DEFAULT_ROLLUP_STAGE_B_TIMEOUT_MS;
  // TASK-191 Task 3: resolve once here (not inside registerMemorySearch) so
  // the default lives alongside every other cfg-default in this constructor.
  const retrievalMode = cfg.retrievalMode ?? 'orchestrator';
  // Bench temporal-fidelity seam (Task 5): production omits `cfg.nowFn`, so
  // this is exactly `new Date` and every call site below is unchanged.
  const nowFn = cfg.nowFn ?? (() => new Date());

  // Per-agent debouncer for the Consolidator (I10). Created at plugin
  // construction so it is shared across all chat:end firings for this
  // plugin instance.
  //
  // No `shutdown()` flush of pending debouncer timers — Plugin.shutdown
  // is resource-release only (per @ax/core contract). The debouncer's
  // `timer.unref?.()` ensures pending passes don't keep Node alive on
  // SIGINT; if a pass is in-flight at shutdown it gets the OS termination,
  // which is fine because inbox state is canonical and the next chat:end
  // after restart will re-cluster + re-promote anything that was pending.
  const debouncer = createDebouncer(consolidatorDebounceMs);
  cfg.testHooks?.onDebouncerCreated?.(debouncer);

  // I10 serialization: track the underlying runConsolidation Promise for each
  // agent so that a new pass can wait for the prior pass's actual fs work to
  // settle before starting. Without this, raceTimeout abandons the caller but
  // the underlying work keeps mutating inbox/ and docs/; if a new chat:end
  // arrives before that work settles, two passes race on the same files.
  const inflightWork = new Map<string, Promise<unknown>>();

  // Test-only: the most-recent underlying `runConsolidation` promise per agent.
  // Unlike `inflightWork` (deleted when a pass settles), this is NOT cleared, so
  // a test can always await the latest pass's REAL fs work — the work the
  // consolidator detaches and that outlives the bounded `raceTimeout` wrapper
  // `Debouncer.flush()` resolves on. Never read by production code.
  const lastWork = new Map<string, Promise<unknown>>();
  // Settle: await the agent's latest consolidation work, looping until no newer
  // pass has been scheduled (so a settle that races a freshly-fired pass still
  // waits for it). Resolves immediately if no pass ever ran.
  const settleConsolidation = async (agentId: string): Promise<void> => {
    let awaited: Promise<unknown> | undefined;
    // Bounded loop: each scheduled pass replaces `lastWork` at most once per
    // flush; we re-await only while the tracked promise actually changed.
    for (let i = 0; i < 100; i++) {
      const current = lastWork.get(agentId);
      if (current === undefined || current === awaited) return;
      awaited = current;
      try { await current; } catch { /* pass errors already logged */ }
    }
  };
  cfg.testHooks?.onConsolidationSettleReady?.(settleConsolidation);

  // Test-only: the most-recent fire-and-forget Observer promise per agent. Like
  // `lastWork` above, it is NEVER cleared and NEVER read by production — it lets
  // a test deterministically await the Observer chain (`agents:resolve →
  // llm:call → write-inbox`) that `chat:end` detaches per I6, instead of racing
  // a fixed wall-clock sleep (the ENOENT-scandir flake). Resolves immediately
  // when no Observer has run for the agent.
  const lastObserverWork = new Map<string, Promise<unknown>>();
  const settleObserver = async (agentId: string): Promise<void> => {
    let awaited: Promise<unknown> | undefined;
    for (let i = 0; i < 100; i++) {
      const current = lastObserverWork.get(agentId);
      if (current === undefined || current === awaited) return;
      awaited = current;
      try { await current; } catch { /* observer errors already swallowed + logged */ }
    }
  };
  cfg.testHooks?.onObserverSettleReady?.(settleObserver);

  // Test-only consolidation override (defaults to the real fs pass in
  // production). See MemoryStrataConfig.testHooks.runConsolidation — this
  // is the seam timeout/serialization tests use to drive a fake-timer-
  // controlled pass so `raceTimeout` fires deterministically under load.
  const consolidate = cfg.testHooks?.runConsolidation ?? runConsolidation;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['memory:doc:written', 'memory:doc:deleted', 'tool:execute:memory_search', 'tool:execute:memory_read_section', 'tool:execute:memory_note', 'system-prompt:augment', 'memory:rules:read', 'memory:rules:write', 'memory:learned:read'],
      // I5: minimal capability list. We `agents:resolve` to read the
      // agent's systemPrompt + model; we call llmCallHook for extraction.
      // No filesystem capability is declared at the manifest level
      // because the plugin manifest schema only carries hook names —
      // FS access is by-process today (a future capability declaration
      // would name `<workspace>/permanent/memory/` here).
      //
      // `memory:index:upsert` is a HARD dependency: the kernel's
      // verifyCalls() throws missing-service if no indexer plugin is
      // loaded alongside memory-strata. This is intentional — the preset
      // wiring task (2B.13) ensures both the CLI preset (sqlite) and the
      // k8s preset (postgres) load an indexer. A configuration without
      // any indexer is misconfigured, and failing fast at bootstrap is
      // better than silently accumulating reindex warn logs at runtime.
      // If a test harness loads memory-strata in isolation it must either
      // register a no-op service for 'memory:index:upsert' or skip
      // bootstrap() and drive bus.subscribe/fire directly.
      //
      // `tool:register` is called at init time to register the
      // memory_search agent tool with the tool catalog (tool-dispatcher).
      // `memory:index:delete` is a HARD dependency for the same reason as
      // `memory:index:upsert`: both are registered by the SAME indexer plugin
      // (sqlite or postgres), so any deployment with an indexer has both. The
      // reindexer's `memory:doc:deleted` branch maps a doc removal to it.
      // `llmCallHook` is the FIXED-tier provider (Stage-B naming) and
      // `memoryOpsHook` is the memory-ops role's provider (observer extraction,
      // map densification). BOTH are hard dependencies, which is what makes a
      // host missing its memory provider fail at BOOT: `validateDependencyGraph`
      // refuses a declared `calls` entry that no loaded plugin registers, before
      // any init runs.
      //
      // They are usually the same hook and deduped here. They diverge when an
      // operator points `memoryOpsModel` at a different provider than
      // `llmCallHook` — and that case is exactly why the memory-ops hook is
      // declared rather than left to the runtime `bus.hasService` guard: an
      // undeclared provider would be missing SILENTLY, costing every turn's
      // memory extraction with nothing but a warn to show for it.
      //
      // These used to be per-agent (`llm:call:<whatever the agent's model ref
      // named>`), which is not enumerable at manifest-build time and so could
      // only ever be a runtime check. Pinning memory ops to a fixed role is
      // what makes the boot-time guarantee possible at all.
      calls: [
        'agents:resolve',
        ...new Set([llmCallHook, memoryOpsHook]),
        'memory:index:upsert',
        'memory:index:delete',
        'tool:register',
      ],
      subscribes: ['chat:start', 'chat:end', 'memory:doc:written', 'memory:doc:deleted'],
    },

    async init({ bus }) {
      // Register the memory_search agent tool with the tool catalog.
      // tool:register is a service hook provided by @ax/tool-dispatcher;
      // we await it here so the tool is visible in the catalog before
      // any tool:list call arrives.
      await registerMemorySearch(bus, {
        retrievalMode,
        ...(cfg.orchestrator ? { orchestrator: cfg.orchestrator } : {}),
      });
      await registerMemoryReadSection(bus);
      await registerMemoryNote(bus);
      registerInject(bus);
      // The human-owned tier's read/write pair + the agent's own working docs
      // (TASK-234). Service hooks, not tools: the caller is the Memory tab, and
      // the agent already reads its memory through injection + memory_search.
      registerRulesHooks(bus);

      bus.subscribe<ChatStartPayload>(
        'chat:start',
        PLUGIN_NAME,
        async (ctx, _payload, { signal }) => {
          // Subscriber posture: NEVER throw. The bus already swallows +
          // logs subscriber errors, but doing it here keeps log keys
          // stable + pins the plugin name.
          try {
            const stoppedAt = await handleChatStart(bus, ctx, nowFn, signal);
            if (stoppedAt !== null) {
              // The bus gave up on us (chat:start's subscriberTimeoutMs) and
              // we stopped before writing anything. Warn, not debug: the
              // seed was NOT written this turn, and the next turn retries.
              // If this shows up on healthy first turns, the bound is too
              // tight for the tier — raise it, the same advice as the bound.
              ctx.logger.warn('memory_strata_bootstrap_aborted', {
                agentId: ctx.agentId,
                stage: stoppedAt,
              });
            }
          } catch (err) {
            ctx.logger.warn('memory_strata_bootstrap_failed', {
              err: err instanceof Error ? err : new Error(String(err)),
              agentId: ctx.agentId,
            });
          }
          return undefined;
        },
      );

      // Observer subscriber (Phase 1). Fire-and-forget per I6. Unchanged.
      bus.subscribe<ChatEndPayload>('chat:end', PLUGIN_NAME, async (ctx, payload) => {
        // Routine-fire guard: a scheduled @ax/routines fire runs a hidden,
        // non-user turn through the same agent:invoke path. Extracting memory
        // from those turns pollutes the agent's episodic memory (the existing
        // heartbeat routine already does this), and is the precondition for the
        // skill-crystallization design's skill-reflection routine to NOT reflect
        // on its own reflection turns. Skip extraction entirely when this ctx
        // originates from a routine fire. See AgentContext.source.
        if (ctx.source === 'routine') return undefined;
        // Fire-and-forget per I6. We DELIBERATELY don't await the
        // Observer — chat:end's other subscribers shouldn't wait on a
        // 30s LLM call. Errors are swallowed + logged; the Observer's
        // own timeout handles the slow-LLM case.
        const observerWork = kickOffObserver(bus, ctx, payload, {
          observerTimeoutMs,
          nowFn,
          memoryOpsModel,
        }).catch((err) => {
          logMemoryPathFailure(ctx, 'observer', err);
        });
        // Test-only settle handle: record the ALREADY-caught promise (so an
        // awaiting test never re-throws) so a test can deterministically await
        // the detached Observer chain instead of sleeping. Never read in prod.
        lastObserverWork.set(ctx.agentId, observerWork);
        return undefined;
      });

      // Re-indexer subscriber (Phase 2B, I18). Listens for
      // `memory:doc:written` (emitted by the Consolidator after every
      // doc write) and calls `memory:index:upsert` with the canonical
      // on-disk content. Re-reading from disk (rather than trusting the
      // event payload) prevents index drift if any upstream transform
      // raced the event. Non-fatal: errors are caught + logged; the
      // subscriber never throws out.
      registerReindexer(bus);

      // Consolidator subscriber (Phase 2A, I10). Returns immediately —
      // the debouncer schedules the actual consolidation pass to run
      // after the debounce window, coalescing rapid back-to-back chats
      // for the same agent into a single pass. The pass is bounded by
      // consolidatorTimeoutMs (default 60 s); exceeded passes are
      // abandoned cleanly (atomic writes guarantee no partial state).
      //
      // I10 serialization (C4 fix): before starting a new pass we wait for
      // the prior pass's underlying runConsolidation promise to settle, even
      // if raceTimeout already gave up on it. Without this, a slow pass that
      // times out keeps mutating inbox/ and docs/ in the background; the next
      // chat:end then starts a second pass that races on the same files.
      bus.subscribe<ChatEndPayload>('chat:end', PLUGIN_NAME, async (ctx) => {
        // Routine-fire guard (twin of the Observer guard above): skip
        // consolidation triggered by a hidden routine turn so a scheduled fire
        // doesn't promote/decay the agent's memory off its own internal work.
        // See AgentContext.source.
        if (ctx.source === 'routine') return undefined;
        debouncer.schedule(ctx.agentId, async () => {
          // Wait for any prior pass's actual fs work to complete before starting
          // a new one — even if our caller already gave up via raceTimeout.
          const prior = inflightWork.get(ctx.agentId);
          if (prior !== undefined) {
            try { await prior; } catch { /* prior pass errors already logged */ }
          }

          // TASK-182: route the consolidation pass through the `/agent` git
          // tier when one is loaded (k8s preset). hydrate → run the existing
          // fs pass on the scratch → flush the consolidated docs/recent back to
          // the tier so they materialize into the runner's `/agent` for the
          // reflection turn. The tracked `work` Promise covers hydrate + pass +
          // flush so the I10 serialization (inflightWork) still gates the whole
          // operation. When there's no tier, the pass runs directly on the host
          // workspace root (CLI path), exactly as before.
          const work = consolidateRoutedToTier({
            bus,
            ctx,
            consolidate,
            llmCallHook,
            mapDensifyEnabled,
            mapDensifyTimeoutMs,
            memoryOpsModel,
            rollupStageBEnabled,
            rollupStageBModel,
            rollupStageBTimeoutMs,
            nowFn,
          });
          inflightWork.set(ctx.agentId, work);
          // Test-only settle handle: record the latest underlying work so a
          // test can await the REAL fs work after flush() (see lastWork above).
          lastWork.set(ctx.agentId, work);
          // Detach: the inflight slot is cleared when the underlying work settles,
          // independent of when our caller stops awaiting (via raceTimeout).
          void work
            .catch(() => {})
            .finally(() => {
              if (inflightWork.get(ctx.agentId) === work) {
                inflightWork.delete(ctx.agentId);
              }
            });

          try {
            await raceTimeout(work, consolidatorTimeoutMs, 'consolidator');
          } catch (err) {
            ctx.logger.warn('memory_strata_consolidator_failed', {
              err: err instanceof Error ? err : new Error(String(err)),
              agentId: ctx.agentId,
            });
          }
        });
        return undefined;
      });
    },

  };
}

/** The bootstrap seed files as `/agent` tier paths — what chat:start hydrates. */
const SEED_TIER_PATHS: readonly string[] = BOOTSTRAP_SEED_FILES.map(scratchRelToTierPath);
const SEED_AGENT_TIER_PATH = scratchRelToTierPath(systemFile('agent'));

/**
 * Where bootstrap stopped because the bus aborted its signal, or `null` when
 * it ran to the end (or had nothing to do).
 *
 * TASK-552: chat:start is fired with a subscriber bound. Past it the turn
 * has moved on without us and our signal is aborted. Bootstrap checks it
 * before each step that commits something — the identity read, the local
 * seed write, and above all the tier flush (a `workspace:apply` to shared
 * storage) — so a bootstrap that blew its bound stops instead of writing into
 * the agent's tier after the turn it belonged to. Stopping is safe:
 * bootstrap creates missing seed files and repairs a `system/agent.md` that
 * still holds exactly the placeholder (TASK-556) — it never touches a file
 * that holds the agent's own content — and the next turn's chat:start redoes
 * both from scratch. What it cannot stop is a step already in flight —
 * the tier hooks take no signal — so the checks bound the work to "at most
 * the step that was running at the bound".
 */
type BootstrapStopStage = 'resolved' | 'hydrated' | 'seeded';

/** Does this chat:start need the agent's composed identity? Only when
 *  `system/agent.md` is absent (it will be created) or still holds the
 *  placeholder (it will be repaired, TASK-556) — bootstrap writes it in no
 *  other case, so any other turn skips the identity reads. */
function needsIdentity(existingAgentMd: string | undefined): boolean {
  return existingAgentMd === undefined || isPlaceholderAgentFile(existingAgentMd);
}

async function handleChatStart(
  bus: HookBus,
  ctx: AgentContext,
  // Bench temporal-fidelity seam (TASK-204): threaded into bootstrapMemoryTree so
  // an e2e replay stamps the seed files with the corpus date, not wall-clock.
  // Production passes `() => new Date()`, so this is a no-op there.
  nowFn: () => Date,
  signal: AbortSignal,
): Promise<BootstrapStopStage | null> {
  const agent = await resolveAgent(bus, ctx);
  if (agent === null) {
    // No agent record (e.g., a synthetic ctx without a registered agent).
    // Skip silently — the next chat for a real agent will seed.
    return null;
  }
  if (signal.aborted) return 'resolved';

  // TASK-182: in a deployment whose memory home is the per-agent `/agent` git
  // tier (k8s preset), seed the memory tree there — NOT on the shared host CWD
  // — so it (a) is per-agent isolated and (b) materializes into the runner's
  // `/agent` for the reflection turn to Read. chat:start fires BEFORE
  // sandbox:open-session materializes `/agent`, so a flush here is visible to
  // the runner on the same turn.
  if (agentTierAvailable(bus)) {
    // TASK-513: hydrate ONLY the bootstrap seed files, not the whole
    // `memory/**` subtree. Each tier read is a round trip to the storage
    // backend (~80 ms on git-server), serialised, on the blocking dispatch
    // path — a full hydrate made chat:start linear in the agent's memory size
    // (8.4 s at 100 docs). Bootstrap only asks "does each seed file exist?"
    // (and, for agent.md, "is it still the placeholder?"), and it writes only
    // seed files — creating missing ones, repairing a placeholder agent.md
    // (TASK-556) — so a partial hydrate is safe for the flush below: deletions
    // are baseline-minus-scratch, unread files are in neither, and a repaired
    // agent.md is in the baseline, so it ships as a plain put.
    const hydrated = await hydrateAgentTier(bus, ctx, { only: SEED_TIER_PATHS });
    try {
      if (signal.aborted) return 'hydrated';
      // Identity lives in the tier at `.ax/IDENTITY.md` + `.ax/SOUL.md`, not on
      // the host FS — read it through the workspace hook (owner-routed by ctx).
      // It is only ever the body of a NEW `system/agent.md`, or of one still
      // holding the placeholder (TASK-556 repair); any other agent.md is never
      // rewritten, so skip both reads in the (every turn after the first)
      // case where the hydrate found a real one. When read, pin to the
      // snapshot the memory came from. A read that throws propagates
      // (TASK-553): nothing is flushed, the subscriber logs
      // memory_strata_bootstrap_failed with the agent id, and the next turn
      // retries, instead of this turn seeding a placeholder over a blip.
      const existingAgent = hydrated.baseline.get(SEED_AGENT_TIER_PATH);
      const composedIdentity = needsIdentity(
        existingAgent === undefined ? undefined : new TextDecoder('utf-8').decode(existingAgent),
      )
        ? await composeIdentityFromTier(bus, ctx, hydrated.baseVersion ?? undefined)
        : '';
      await bootstrapMemoryTree({
        workspaceRoot: hydrated.scratchRoot,
        composedIdentity,
        nowFn,
      });
      // The last and most important check: the flush is the write to shared
      // storage. The scratch seeded above is disposed below either way.
      if (signal.aborted) return 'seeded';
      await flushAgentTier(bus, ctx, hydrated, 'memory-bootstrap');
    } finally {
      await hydrated.dispose();
    }
    return null;
  }

  // CLI / local-FS deployment: memory lives directly under the agent's own
  // workspace root (workspace-localdir gives each agent its own subtree, and
  // the runner IS the host process, so the tree is already where the agent
  // reads it). Unchanged from before TASK-182.
  //
  // TASK-142: seed `system/agent.md` from the agent's COMPOSED identity (its
  // own `.ax/IDENTITY.md` + `.ax/SOUL.md`), not the dropped `system_prompt`
  // column. Empty when the agent hasn't authored its identity yet (still
  // bootstrapping) — bootstrapMemoryTree seeds a placeholder body in that case,
  // and replaces it on a later turn that composes a real one (TASK-556). Read
  // identity only when agent.md is absent or still the placeholder: a read
  // error now fails the seed (TASK-556), and it must not fail every turn of a
  // warm agent whose agent.md bootstrap would never rewrite anyway.
  const existingAgent = await readRegularFile(join(ctx.workspace.rootPath, systemFile('agent')));
  const composedIdentity = needsIdentity(existingAgent)
    ? await composeIdentityFromFiles(ctx.workspace.rootPath)
    : '';
  if (signal.aborted) return 'resolved';
  await bootstrapMemoryTree({
    workspaceRoot: ctx.workspace.rootPath,
    composedIdentity,
    nowFn,
  });
  return null;
}

async function kickOffObserver(
  bus: HookBus,
  ctx: AgentContext,
  payload: ChatEndPayload,
  cfg: { observerTimeoutMs: number; nowFn: () => Date; memoryOpsModel: string },
): Promise<void> {
  // Terminated outcomes (chat:start veto, runner crash, timeout) carry no
  // transcript. Skip cleanly.
  if (payload.outcome.kind !== 'complete') return;
  if (payload.outcome.messages.length === 0) return;

  // Pinned to the memory-ops role, NOT the calling agent's model (2026-09-14).
  // Extraction is a fixed internal job; letting it follow whatever model the
  // user picked for chat made memory quality and cost unstatable.
  const role = resolveMemoryOpsModel(ctx, cfg.memoryOpsModel);
  if (role === null) return;
  const llmCall = buildMemoryOpsLlmCall(bus, ctx, role, 'observer');
  if (llmCall === undefined) return;

  // TASK-182: when memory lives in the `/agent` git tier, hydrate the agent's
  // current memory tree into a scratch, run the observer there, and flush the
  // new inbox observation back to the tier. The inbox accumulates across turns
  // in the tier; the next consolidation pass (or reflection turn) sees it. When
  // there's no tier, run directly on the host workspace root (CLI path).
  const hydrated = agentTierAvailable(bus) ? await hydrateAgentTier(bus, ctx) : null;
  const workspaceRoot = hydrated?.scratchRoot ?? ctx.workspace.rootPath;

  try {
    const result = await runObserver({
      messages: payload.outcome.messages,
      llmCall,
      workspaceRoot,
      now: cfg.nowFn(),
      timeoutMs: cfg.observerTimeoutMs,
      model: role.model,
      // TASK-187: thread the DURABLE per-conversation key onto each inbox
      // observation. conversationId (not sessionId) is stable across a
      // conversation's turns/respawns — the Consolidator dedups it to count
      // distinct conversations for the skill-crystallization recurrence gate.
      conversationId: ctx.conversationId,
      onLate: (info) => {
        ctx.logger.warn('memory_strata_observer_late', {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          ...info,
        });
      },
    });

    if (hydrated !== null) {
      await flushAgentTier(bus, ctx, hydrated, 'memory-observe');
    }

    // Audit-style structured logs so an operator can see at a glance how
    // many observations a chat produced + how many the gate vetoed. No
    // observation content is logged — only counts and rejection kinds.
    if (result.kind === 'written') {
      if (result.written.length > 0 || result.rejected.length > 0) {
        ctx.logger.info('memory_strata_observer_run', {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          written: result.written.length,
          rejected: result.rejected.length,
          rejectedKinds: result.rejected.flatMap((r) => r.kinds),
          // Truncated extraction: complete facts were kept, the tail was lost.
          // Never silent — a persistent signal here means MAX_EXTRACTION_TOKENS
          // needs another raise.
          ...(result.salvagedFromTruncation === true ? { salvagedFromTruncation: true } : {}),
        });
      }
    } else if (result.kind === 'parse-error') {
      ctx.logger.debug('memory_strata_observer_parse_error', {
        agentId: ctx.agentId,
        rawLength: result.rawLength,
      });
    }
  } finally {
    if (hydrated !== null) await hydrated.dispose();
  }
}

/**
 * Run one consolidation pass, routed through the `/agent` git tier when one is
 * loaded (TASK-182). Returns the consolidator's audit result so the tracked
 * `work` Promise resolves to the same value as a direct pass.
 *
 * Tier path: hydrate the agent's memory tree into a scratch, run the pass on
 * the scratch, then flush the result (promoted docs, regenerated recent.md,
 * deleted inbox files) back to the tier via `workspace:apply`. The scratch is
 * disposed afterwards — `/agent` is the single durable home (Invariant 4).
 *
 * No-tier path (CLI): run directly on the host workspace root, unchanged.
 */
async function consolidateRoutedToTier(deps: {
  bus: HookBus;
  ctx: AgentContext;
  consolidate: (input: ConsolidationInput) => Promise<ConsolidationResult>;
  llmCallHook: string;
  mapDensifyEnabled: boolean;
  mapDensifyTimeoutMs: number;
  rollupStageBEnabled: boolean;
  rollupStageBModel: string;
  rollupStageBTimeoutMs: number;
  memoryOpsModel: string;
  nowFn: () => Date;
}): Promise<ConsolidationResult> {
  const {
    bus, ctx, consolidate, llmCallHook, mapDensifyEnabled, mapDensifyTimeoutMs,
    rollupStageBEnabled, rollupStageBModel, rollupStageBTimeoutMs, memoryOpsModel, nowFn,
  } = deps;
  const logger = {
    info: (event: string, fields: Record<string, unknown>) => ctx.logger.info(event, fields),
    warn: (event: string, fields: Record<string, unknown>) => ctx.logger.warn(event, fields),
  };

  // TASK-190: build the host-LLM map densifier (same `llm:call:*` gating as the
  // Observer). When densify is disabled, or the memory-ops ref can't be parsed,
  // `densifyMap` is undefined and `regenerateMap` falls back to raw doc
  // summaries — the map is still generated, just not densified. Resolving the
  // model here keeps map.ts bus-agnostic.
  const densifyMap = await buildMapDensifier({
    bus,
    ctx,
    enabled: mapDensifyEnabled,
    timeoutMs: mapDensifyTimeoutMs,
    memoryOpsModel,
  });

  // TASK-201: build the Stage-B rollup namer (bounded LLM class naming over the
  // residue). Same `llm:call:*` gating as the densifier/Observer, but a FIXED
  // extraction model (not the agent's) — so no `agents:resolve`. When disabled or
  // no provider is registered, `rollupStageB` is undefined and the rollup pass
  // runs Stage A only. Bus-agnostic (the closure captures the call), so the tier
  // path — which runs the pass without a bus — can still name.
  const rollupStageB = buildStageBNamer({
    bus,
    ctx,
    llmCallHook,
    enabled: rollupStageBEnabled,
    model: rollupStageBModel,
    timeoutMs: rollupStageBTimeoutMs,
  });

  if (!agentTierAvailable(bus)) {
    return consolidate({
      workspaceRoot: ctx.workspace.rootPath,
      now: nowFn(),
      logger,
      bus,
      ctx,
      densifyMap,
      rollupStageB,
    });
  }

  const hydrated: HydratedTier = await hydrateAgentTier(bus, ctx);
  try {
    // Run the pass on the scratch WITHOUT bus/ctx, so the consolidator's
    // inline `memory:doc:written` events don't fire mid-pass — at that point
    // the doc lives only in the about-to-be-flushed scratch, not in `/agent`,
    // and the tier-aware reindexer reads `/agent`. We re-emit those events
    // AFTER the flush (below) from the durable `/agent` content instead.
    const result = await consolidate({
      workspaceRoot: hydrated.scratchRoot,
      now: nowFn(),
      logger,
      densifyMap,
      rollupStageB,
    });
    await flushAgentTier(bus, ctx, hydrated, 'memory-consolidate');
    // TASK-186: now that the consolidated docs are durably in `/agent`, fire
    // `memory:doc:written` for each so the (tier-aware) reindexer populates the
    // per-agent-keyed search index from the tier. Pre-TASK-186 this never
    // happened (events were omitted), so `memory_search` returned nothing in
    // tier deployments. Best-effort: a reindex failure must not fail the pass.
    await reindexTierDocs(bus, ctx);
    // TASK-200: the rollup pass ran on the scratch WITHOUT a bus, so its GC
    // `memory:doc:deleted` events never fired. reindexTierDocs re-upserts every
    // doc STILL present (including surviving rollups), but a rollup that was GC'd
    // is gone from `/agent` and would otherwise leave a STALE index row answering
    // `## Count: 3` after the file is gone. Re-fire the deletions here — the
    // symmetric twin of the doc:written re-fire above — so the index row drops.
    for (const docId of result.rollupsDeleted) {
      await bus.fire('memory:doc:deleted', ctx, { docId });
    }
    return result;
  } finally {
    await hydrated.dispose();
  }
}

/**
 * After a tier consolidation flush, fire `memory:doc:written` for every doc now
 * in the agent's `/agent` `memory/docs/**`, so the reindexer upserts them into
 * the search index (TASK-186). Reads are owner-routed by ctx. Each doc's event
 * is independent — one malformed doc doesn't block the rest — and the whole
 * thing is best-effort (a missing indexer just logs a warn in the reindexer).
 */
async function reindexTierDocs(bus: HookBus, ctx: AgentContext): Promise<void> {
  const docsPrefix = `${AGENT_TIER_MEMORY_ROOT}/docs/`;
  let paths: string[];
  try {
    const listed = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list',
      ctx,
      { pathGlob: `${docsPrefix}**` },
    );
    // pathGlob is advisory; filter defensively to `memory/docs/<cat>/<slug>.md`.
    paths = listed.paths.filter((p) => p.startsWith(docsPrefix) && p.endsWith('.md'));
  } catch (err) {
    ctx.logger.warn('memory_strata_reindex_tier_list_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
      agentId: ctx.agentId,
    });
    return;
  }

  for (const tierPath of paths) {
    // tierPath: memory/docs/<category>/<slug>.md → derive docId fields.
    const rel = tierPath.slice(docsPrefix.length); // <category>/<slug>.md
    const slash = rel.indexOf('/');
    if (slash <= 0) continue;
    const category = rel.slice(0, slash);
    const slug = rel.slice(slash + 1, -'.md'.length);
    if (slug.length === 0) continue;

    // `summary` is informational only — the reindexer re-reads the canonical
    // doc from `/agent` and indexes ITS frontmatter.summary, ignoring the
    // event's. So we don't pay a second `workspace:read` here just to fill it.
    await bus.fire('memory:doc:written', ctx, {
      docId: `${category}/${slug}`,
      category,
      slug,
      kind: 'updated' as const,
      summary: '',
    });
  }
}

/**
 * Build the host-LLM map densifier for a consolidation pass (TASK-190), or
 * return `undefined` when densification is disabled or the agent's model can't
 * be resolved (`regenerateMap` then falls back to raw doc summaries). Resolving
 * the model HERE — not inside map.ts — keeps the map module bus-agnostic and
 * test-driveable with a stub densifier.
 */
async function buildMapDensifier(deps: {
  bus: HookBus;
  ctx: AgentContext;
  enabled: boolean;
  timeoutMs: number;
  memoryOpsModel: string;
}): Promise<MapDensifier | undefined> {
  const { bus, ctx, enabled, timeoutMs, memoryOpsModel } = deps;
  if (!enabled) return undefined;
  // Same fixed memory-ops role as the Observer.
  const role = resolveMemoryOpsModel(ctx, memoryOpsModel);
  if (role === null) return undefined;
  const llmCall = buildMemoryOpsLlmCall(bus, ctx, role, 'map-densifier');
  if (llmCall === undefined) return undefined;
  return makeLlmDensifier({ llmCall, model: role.model, timeoutMs });
}

/**
 * Build the Stage-B rollup namer for a consolidation pass (TASK-201), or return
 * `undefined` when Stage B is disabled or no `llm:call` provider is registered
 * (the rollup pass then runs Stage A only). Unlike the map densifier, the model
 * is FIXED (the cheap extraction tier) — so there's no `agents:resolve`; we gate
 * on `bus.hasService(llmCallHook)` so a CI/host without an LLM provider degrades
 * cleanly instead of throwing on every dirty pass. The namer closes over the
 * `llm:call` closure, keeping rollup.ts bus-agnostic (needed for the tier path,
 * which runs the pass without a bus).
 */
function buildStageBNamer(deps: {
  bus: HookBus;
  ctx: AgentContext;
  llmCallHook: string;
  enabled: boolean;
  model: string;
  timeoutMs: number;
}): StageBNamer | undefined {
  const { bus, ctx, llmCallHook, enabled, model, timeoutMs } = deps;
  if (!enabled) return undefined;
  if (!bus.hasService(llmCallHook)) return undefined;
  const llmCall: LlmCallFn = (input) => bus.call(llmCallHook, ctx, input);
  return makeStageBNamer({ llmCall, model, timeoutMs });
}

/**
 * The agent's model, split into the two halves that mean different things:
 * `provider` SELECTS the `llm:call:<provider>` hook, `model` is the bare,
 * provider-native id that hook's payload carries.
 */
interface ResolvedAgentModel {
  provider: string;
  model: string;
}

/**
 * Build the `llm:call` closure for an agent-model-derived path, or `undefined`
 * when the agent's provider has no registered hook on this host — the same
 * graceful-degradation contract as `buildStageBNamer`'s `hasService` gate, so a
 * CI host with no LLM provider still boots and still runs turns.
 *
 * We deliberately do NOT fall back to the configured `llmCallHook`: sending an
 * agent's model id to a provider it wasn't selected for is worse than skipping
 * (wrong-vendor id → 404, or worse, a silently different model). The `warn`
 * makes the skip visible; a misconfigured preset shouldn't kill memory quietly.
 */
/**
 * Build the LLM call for a MEMORY OPERATION, pinned to
 * {@link DEFAULT_MEMORY_OPS_MODEL} rather than the calling agent's model.
 *
 * Returns `undefined` — never throws — when the role's provider has no
 * registered hook on this host, the same graceful-degradation contract
 * the agent-derived path had: a CI host with no LLM provider still boots and still
 * runs turns, it just extracts no memory. The `warn` makes the skip visible.
 *
 * {@link MEMORY_OPS_REASONING} is applied HERE, not at the call sites, and it
 * deliberately wins over anything a caller passes: the role owns this choice,
 * and a call site that could override it is a call site that can forget it.
 */
function buildMemoryOpsLlmCall(
  bus: HookBus,
  ctx: AgentContext,
  role: ResolvedAgentModel,
  path: string,
): LlmCallFn | undefined {
  const hook = `llm:call:${role.provider}`;
  if (!bus.hasService(hook)) {
    ctx.logger.warn('memory_strata_llm_provider_unregistered', {
      agentId: ctx.agentId,
      provider: role.provider,
      hook,
      path,
    });
    return undefined;
  }
  return (input) => bus.call(hook, ctx, { ...input, reasoningEffort: MEMORY_OPS_REASONING });
}

/**
 * Log a memory-path failure at the right volume: a missing credential is an
 * ERROR under its own event (it will not fix itself and costs every turn),
 * anything else keeps the path's existing warn.
 */
function logMemoryPathFailure(ctx: AgentContext, path: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  if (isMissingCredential(err)) {
    ctx.logger.error(NO_CREDENTIAL_EVENT, {
      err: error,
      agentId: ctx.agentId,
      path,
      ...noCredentialFields(),
    });
    return;
  }
  ctx.logger.warn(`memory_strata_${path}_failed`, { err: error, agentId: ctx.agentId });
}

/**
 * Parse the configured memory-ops ref into `{ provider, model }`.
 *
 * A bad value is a real misconfiguration, so it warns and degrades to "no
 * memory ops" rather than throwing every turn — same posture as an
 * unregistered provider.
 */
function resolveMemoryOpsModel(
  ctx: AgentContext,
  ref: string,
): ResolvedAgentModel | null {
  try {
    const parsed = parseModelRef(ref);
    return { provider: parsed.provider, model: parsed.modelId };
  } catch (err) {
    ctx.logger.warn('memory_strata_memory_ops_model_ref_invalid', {
      err: err instanceof Error ? err : new Error(String(err)),
      ref,
    });
    return null;
  }
}

async function resolveAgent(
  bus: HookBus,
  ctx: AgentContext,
): Promise<ResolvedAgentModel | null> {
  let ref: string;
  try {
    const out = await bus.call<{ agentId: string; userId: string }, AgentResolveResponse>(
      'agents:resolve',
      ctx,
      { agentId: ctx.agentId, userId: ctx.userId },
    );
    ref = out.agent.model;
  } catch (err) {
    // debug, not warn: the common cause is a synthetic ctx with no agent row
    // (handled + documented at every call site), which is an expected no-op.
    ctx.logger.debug('memory_strata_agent_resolve_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
      agentId: ctx.agentId,
    });
    return null;
  }
  // `agents_v1_agents.model` is a `provider/model-id` ref (PR 2); the migration
  // backfills the prefix, so a bare or malformed value here is a real
  // misconfiguration, NOT an expected state — hence `warn`, in its own catch.
  // Folding it into the resolve catch above would inherit `debug` and hide
  // exactly the class of bug this parse exists to prevent (every turn's memory
  // extraction silently stops).
  try {
    const parsed = parseModelRef(ref);
    return { provider: parsed.provider, model: parsed.modelId };
  } catch (err) {
    ctx.logger.warn('memory_strata_agent_model_ref_invalid', {
      err: err instanceof Error ? err : new Error(String(err)),
      agentId: ctx.agentId,
      model: ref,
    });
    return null;
  }
}
