import type { AgentContext, AgentOutcome, HookBus, Plugin } from '@ax/core';
import { bootstrapMemoryTree } from './bootstrap.js';
import { runConsolidation, type ConsolidationInput, type ConsolidationResult } from './consolidator.js';
import { createDebouncer, type Debouncer } from './debounce.js';
import { registerInject } from './inject.js';
import { runObserver, type LlmCallFn } from './observer.js';
import { registerReindexer } from './reindex.js';
import { raceTimeout } from './timeout.js';
import { registerMemorySearch } from './tools/memory-search.js';
import { registerMemoryReadSection } from './tools/memory-read-section.js';
import { registerMemoryNote } from './tools/memory-note.js';

const PLUGIN_NAME = '@ax/memory-strata';
const PLUGIN_VERSION = '0.0.0';

const DEFAULT_OBSERVER_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_HOOK = 'llm:call:anthropic';
const DEFAULT_CONSOLIDATOR_DEBOUNCE_MS = 5_000;
const DEFAULT_CONSOLIDATOR_TIMEOUT_MS = 60_000;

export interface MemoryStrataConfig {
  /**
   * Bus hook to call for the Observer's LLM round-trip. Default
   * `llm:call:anthropic` matches the only registered host-side LLM
   * provider today. A future preset that registers `llm:call:openai`
   * (or `llm:call:proxy`) overrides this.
   */
  llmCallHook?: string;
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
  agent: { systemPrompt: string; model: string };
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
  const observerTimeoutMs = cfg.observerTimeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS;
  const consolidatorDebounceMs = cfg.consolidatorDebounceMs ?? DEFAULT_CONSOLIDATOR_DEBOUNCE_MS;
  const consolidatorTimeoutMs = cfg.consolidatorTimeoutMs ?? DEFAULT_CONSOLIDATOR_TIMEOUT_MS;

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
      registers: ['memory:doc:written', 'tool:execute:memory_search', 'tool:execute:memory_read_section', 'tool:execute:memory_note', 'system-prompt:augment'],
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
      calls: ['agents:resolve', llmCallHook, 'memory:index:upsert', 'tool:register'],
      subscribes: ['chat:start', 'chat:end', 'memory:doc:written'],
    },

    async init({ bus }) {
      // Register the memory_search agent tool with the tool catalog.
      // tool:register is a service hook provided by @ax/tool-dispatcher;
      // we await it here so the tool is visible in the catalog before
      // any tool:list call arrives.
      await registerMemorySearch(bus);
      await registerMemoryReadSection(bus);
      await registerMemoryNote(bus);
      registerInject(bus);

      bus.subscribe<ChatStartPayload>(
        'chat:start',
        PLUGIN_NAME,
        async (ctx) => {
          // Subscriber posture: NEVER throw. The bus already swallows +
          // logs subscriber errors, but doing it here keeps log keys
          // stable + pins the plugin name.
          try {
            await handleChatStart(bus, ctx);
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
        // Fire-and-forget per I6. We DELIBERATELY don't await the
        // Observer — chat:end's other subscribers shouldn't wait on a
        // 30s LLM call. Errors are swallowed + logged; the Observer's
        // own timeout handles the slow-LLM case.
        const observerWork = kickOffObserver(bus, ctx, payload, {
          llmCallHook,
          observerTimeoutMs,
        }).catch((err) => {
          ctx.logger.warn('memory_strata_observer_failed', {
            err: err instanceof Error ? err : new Error(String(err)),
            agentId: ctx.agentId,
          });
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
        debouncer.schedule(ctx.agentId, async () => {
          // Wait for any prior pass's actual fs work to complete before starting
          // a new one — even if our caller already gave up via raceTimeout.
          const prior = inflightWork.get(ctx.agentId);
          if (prior !== undefined) {
            try { await prior; } catch { /* prior pass errors already logged */ }
          }

          const work = consolidate({
            workspaceRoot: ctx.workspace.rootPath,
            now: new Date(),
            logger: {
              info: (event, fields) => ctx.logger.info(event, fields),
              warn: (event, fields) => ctx.logger.warn(event, fields),
            },
            bus,
            ctx,
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

async function handleChatStart(bus: HookBus, ctx: AgentContext): Promise<void> {
  const agent = await resolveAgent(bus, ctx);
  if (agent === null) {
    // No agent record (e.g., a synthetic ctx without a registered agent).
    // Skip silently — without a system prompt the bootstrap would seed a
    // confusing placeholder. The next chat for a real agent will seed.
    return;
  }
  await bootstrapMemoryTree({
    workspaceRoot: ctx.workspace.rootPath,
    agentSystemPrompt: agent.systemPrompt,
  });
}

async function kickOffObserver(
  bus: HookBus,
  ctx: AgentContext,
  payload: ChatEndPayload,
  cfg: { llmCallHook: string; observerTimeoutMs: number },
): Promise<void> {
  // Terminated outcomes (chat:start veto, runner crash, timeout) carry no
  // transcript. Skip cleanly.
  if (payload.outcome.kind !== 'complete') return;
  if (payload.outcome.messages.length === 0) return;

  const agent = await resolveAgent(bus, ctx);
  if (agent === null) return;

  const llmCall: LlmCallFn = (input) => bus.call(cfg.llmCallHook, ctx, input);

  const result = await runObserver({
    messages: payload.outcome.messages,
    llmCall,
    workspaceRoot: ctx.workspace.rootPath,
    now: new Date(),
    timeoutMs: cfg.observerTimeoutMs,
    model: agent.model,
    onLate: (info) => {
      ctx.logger.warn('memory_strata_observer_late', {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        ...info,
      });
    },
  });

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
      });
    }
  } else if (result.kind === 'parse-error') {
    ctx.logger.debug('memory_strata_observer_parse_error', {
      agentId: ctx.agentId,
      rawLength: result.rawLength,
    });
  }
}

async function resolveAgent(
  bus: HookBus,
  ctx: AgentContext,
): Promise<{ systemPrompt: string; model: string } | null> {
  try {
    const out = await bus.call<{ agentId: string; userId: string }, AgentResolveResponse>(
      'agents:resolve',
      ctx,
      { agentId: ctx.agentId, userId: ctx.userId },
    );
    return { systemPrompt: out.agent.systemPrompt, model: out.agent.model };
  } catch (err) {
    ctx.logger.debug('memory_strata_agent_resolve_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
      agentId: ctx.agentId,
    });
    return null;
  }
}
