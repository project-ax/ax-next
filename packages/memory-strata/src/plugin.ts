import type { AgentContext, AgentOutcome, HookBus, Plugin } from '@ax/core';
import { bootstrapMemoryTree } from './bootstrap.js';
import { runConsolidation } from './consolidator.js';
import { createDebouncer, type Debouncer } from './debounce.js';
import { runObserver, type LlmCallFn } from './observer.js';
import { raceTimeout } from './timeout.js';

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
   */
  testHooks?: {
    onDebouncerCreated?(debouncer: Debouncer): void;
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

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [],
      // I5: minimal capability list. We `agents:resolve` to read the
      // agent's systemPrompt + model; we call llmCallHook for extraction.
      // No filesystem capability is declared at the manifest level
      // because the plugin manifest schema only carries hook names —
      // FS access is by-process today (a future capability declaration
      // would name `<workspace>/permanent/memory/` here).
      calls: ['agents:resolve', llmCallHook],
      subscribes: ['chat:start', 'chat:end'],
    },

    init({ bus }) {
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
        kickOffObserver(bus, ctx, payload, { llmCallHook, observerTimeoutMs }).catch(
          (err) => {
            ctx.logger.warn('memory_strata_observer_failed', {
              err: err instanceof Error ? err : new Error(String(err)),
              agentId: ctx.agentId,
            });
          },
        );
        return undefined;
      });

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

          const work = runConsolidation({
            workspaceRoot: ctx.workspace.rootPath,
            now: new Date(),
            logger: {
              info: (event, fields) => ctx.logger.info(event, fields),
              warn: (event, fields) => ctx.logger.warn(event, fields),
            },
          });
          inflightWork.set(ctx.agentId, work);
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
