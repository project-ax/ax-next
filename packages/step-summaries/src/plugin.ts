import {
  parseModelRef,
  type AgentContext,
  type HookBus,
  type LlmCallInput,
  type LlmCallOutput,
  type ParsedModelRef,
  type Plugin,
} from '@ax/core';
import { SUMMARY_SYSTEM, summaryUserMessage } from './prompt.js';
import { validateSummary } from './validate.js';

/**
 * @ax/step-summaries — the line a person reads while the agent works.
 *
 * Claude shows "Working out the leg motion with a script." above a running
 * step: a short summary of the reasoning that led to it, never the reasoning.
 * This plugin does the same on the host. It watches `chat:stream-chunk`,
 * keeps the reasoning (`thinking` chunks) of the step in progress, and when a
 * tool call follows it asks the fast model for one present-tense line. The
 * line goes out as a `step-summary` chunk on the same hook (the channel draws
 * it as the live title) and into the conversation's display log as a
 * `step-summary` event keyed by the call id (a reload draws the same line).
 *
 * THE REASONING NEVER LEAVES THIS PLUGIN except as the summary model's input.
 * It is not logged, not stored, not forwarded. What reaches a person is one
 * validated line (`validateSummary`).
 *
 * BEST EFFORT, AFTER THE FACT. The summary call runs off the stream's path:
 * nothing waits for it, and a slow, failed or rejected summary just leaves
 * the step with its plain name ("Running a command…").
 */

const PLUGIN_NAME = '@ax/step-summaries';
const PLUGIN_VERSION = '0.0.0';

/** Same runtime override the conversation-titles plugin reads (admin "Helper model"). */
const FAST_MODEL_STORAGE_KEY = 'settings:fast-model';

/**
 * The fallback summary model, by the same policy as conversation titles:
 * GLM for every service role. `parseModelRef` splits on the FIRST slash.
 */
export const DEFAULT_SUMMARY_MODEL = 'openrouter/z-ai/glm-5.3-flash:nitro';

/** Bounds the spend on one turn that loops through tools. */
export const MAX_SUMMARIES_PER_TURN = 30;
/** "Let me check." is not worth a model call. */
export const MIN_REASONING_CHARS = 40;
/** A call id is an opaque runner token; anything longer is not one. */
const MAX_TOOL_CALL_ID_CHARS = 256;
/** Turns whose end we never saw (a crashed runner) stop being remembered. */
const MAX_TRACKED_TURNS = 500;
// Covers a reasoning model's own thinking too (see conversation-titles).
const SUMMARY_MAX_TOKENS = 1024;
const SUMMARY_REASONING_EFFORT = 'minimal' as const;
const SUMMARY_TEMPERATURE = 0.2;

export interface StepSummariesConfig {
  /** `<provider>/<model-id>`; the admin "Helper model" setting overrides it at runtime. */
  model?: string;
}

interface ChunkPayload {
  reqId?: unknown;
  kind?: unknown;
  text?: unknown;
  toolCallId?: unknown;
}

interface TurnState {
  reasoning: string;
  summaries: number;
}

export function createStepSummariesPlugin(cfg: StepSummariesConfig = {}): Plugin {
  const fallbackRef = cfg.model ?? DEFAULT_SUMMARY_MODEL;
  const fallbackParsed = parseModelRef(fallbackRef);
  const fallbackHook = `llm:call:${fallbackParsed.provider}`;
  const turns = new Map<string, TurnState>();

  /*
    `reqId` rides in the chunk the RUNNER sent, so it is the runner's word.
    The state is keyed by the host-stamped session as well: one session's
    reasoning can never be summarized onto another session's call, whatever
    reqId a runner claims.
  */
  const keyOf = (ctx: AgentContext, reqId: string): string => `${ctx.sessionId}\u0000${reqId}`;
  const stateFor = (key: string): TurnState => {
    let s = turns.get(key);
    if (s === undefined) {
      s = { reasoning: '', summaries: 0 };
      turns.set(key, s);
      // Oldest first (Map insertion order): a turn whose end never arrived.
      if (turns.size > MAX_TRACKED_TURNS) {
        const oldest = turns.keys().next().value;
        if (oldest !== undefined) turns.delete(oldest);
      }
    }
    return s;
  };

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [],
      calls: [fallbackHook, 'storage:get', 'conversations:append-event'],
      subscribes: ['chat:stream-chunk', 'chat:end', 'chat:turn-error'],
    },
    async init({ bus }) {
      bus.subscribe<ChunkPayload>('chat:stream-chunk', PLUGIN_NAME, async (ctx, payload) => {
        const reqId = payload?.reqId;
        if (typeof reqId !== 'string') return undefined;
        const key = keyOf(ctx, reqId);
        if (payload.kind === 'thinking' && typeof payload.text === 'string') {
          const s = stateFor(key);
          // Bounded: only the tail is ever summarized (see prompt.ts).
          s.reasoning = (s.reasoning + payload.text).slice(-12_000);
        } else if (payload.kind === 'text') {
          // The reasoning led to words, not a tool: it is the reply's, not a step's.
          const s = turns.get(key);
          if (s !== undefined) s.reasoning = '';
        } else if (
          payload.kind === 'tool-use' &&
          typeof payload.toolCallId === 'string' &&
          // Runner-chosen and stored as the event's fold key: bounded.
          payload.toolCallId.length > 0 &&
          payload.toolCallId.length <= MAX_TOOL_CALL_ID_CHARS
        ) {
          const s = turns.get(key);
          if (s === undefined) return undefined;
          const reasoning = s.reasoning.trim();
          s.reasoning = '';
          if (reasoning.length < MIN_REASONING_CHARS || s.summaries >= MAX_SUMMARIES_PER_TURN) {
            return undefined;
          }
          s.summaries += 1;
          // Off the stream's path: the chunk fan-out never waits on a model.
          void summarize(bus, ctx, {
            reqId,
            toolCallId: payload.toolCallId,
            reasoning,
            fallbackHook,
            fallbackModelId: fallbackParsed.modelId,
          });
        }
        return undefined;
      });

      // The request is over: forget it. (A `chat:turn-end` is one message of
      // the reply, not the reply, so it is not the moment.) A request whose
      // end never arrives ages out of the bounded map instead.
      const forget = async (ctx: AgentContext): Promise<undefined> => {
        const prefix = `${ctx.sessionId}\u0000`;
        for (const key of [...turns.keys()]) if (key.startsWith(prefix)) turns.delete(key);
        return undefined;
      };
      bus.subscribe<unknown>('chat:end', PLUGIN_NAME, forget);
      bus.subscribe<unknown>('chat:turn-error', PLUGIN_NAME, forget);
    },
  };
}

async function summarize(
  bus: HookBus,
  ctx: AgentContext,
  job: {
    reqId: string;
    toolCallId: string;
    reasoning: string;
    fallbackHook: string;
    fallbackModelId: string;
  },
): Promise<void> {
  try {
    const model = await resolveModel(bus, ctx, job.fallbackHook, job.fallbackModelId);
    const out = await bus.call<LlmCallInput, LlmCallOutput>(model.hook, ctx, {
      model: model.modelId,
      maxTokens: SUMMARY_MAX_TOKENS,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: summaryUserMessage(job.reasoning) }],
      temperature: SUMMARY_TEMPERATURE,
      reasoningEffort: SUMMARY_REASONING_EFFORT,
    });
    const text = validateSummary(out.text);
    if (text === null) {
      // Lengths and codes only: the text is model output about a user's work.
      ctx.logger.debug('step_summaries_validation_skipped', {
        rawLength: out.text.length,
        stopReason: out.stopReason,
      });
      return;
    }
    await bus.fire('chat:stream-chunk', ctx, {
      reqId: job.reqId,
      kind: 'step-summary',
      toolCallId: job.toolCallId,
      text,
    });
    if (ctx.conversationId !== undefined && bus.hasService('conversations:append-event')) {
      await bus.call('conversations:append-event', ctx, {
        conversationId: ctx.conversationId,
        kind: 'step-summary',
        key: job.toolCallId,
        payload: { toolCallId: job.toolCallId, text },
      });
    }
  } catch (err) {
    ctx.logger.warn('step_summaries_failed', {
      code: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/**
 * The admin "Helper model" (`settings:fast-model`) when it names a provider
 * this host has, else the configured fallback. Restated from
 * conversation-titles rather than imported (invariant 2); every failure falls
 * back silently, because a summary is a nicety.
 */
async function resolveModel(
  bus: HookBus,
  ctx: AgentContext,
  fallbackHook: string,
  fallbackModelId: string,
): Promise<{ hook: string; modelId: string }> {
  const fallback = { hook: fallbackHook, modelId: fallbackModelId };
  if (!bus.hasService('storage:get')) return fallback;
  try {
    const r = await bus.call<{ key: string }, { value: Uint8Array | undefined }>('storage:get', ctx, {
      key: FAST_MODEL_STORAGE_KEY,
    });
    if (r.value === undefined || r.value.length === 0) return fallback;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(r.value);
    const parsed: ParsedModelRef = parseModelRef(text);
    const hook = `llm:call:${parsed.provider}`;
    return bus.hasService(hook) ? { hook, modelId: parsed.modelId } : fallback;
  } catch {
    return fallback;
  }
}
