import type { AgentContext, AgentOutcome, HookBus, Plugin } from '@ax/core';
import { bootstrapMemoryTree } from './bootstrap.js';
import { runObserver, type LlmCallFn } from './observer.js';

const PLUGIN_NAME = '@ax/memory-strata';
const PLUGIN_VERSION = '0.0.0';

const DEFAULT_OBSERVER_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_HOOK = 'llm:call:anthropic';

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
