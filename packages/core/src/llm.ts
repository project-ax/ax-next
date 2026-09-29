import { z, type ZodType } from 'zod';
import type { AgentContext } from './context.js';
import type { HookBus } from './hook-bus.js';
import type { LlmCallOutput } from './types.js';

// ---------------------------------------------------------------------------
// Runtime `returns` contract for the `llm:call:anthropic` service hook
// (ARCH-13, the non-IPC long tail spun out of ARCH-6 #150).
//
// `LlmCallOutput` lives in `@ax/core` types.ts (it's the provider-agnostic
// canonical shape every `llm:call:<provider>` registrant must honour), so its
// schema lives here in core alongside the other neutral kernel shapes — NOT in
// workspace.ts (this isn't a workspace concept). Registrants today are
// `@ax/llm-anthropic` (`llm:call:anthropic`) and `@ax/llm-openrouter`
// (`llm:call:openrouter`); any further provider imports this same schema so its
// return shape is validated identically.
//
// Provider-agnostic by construction: `stopReason` is the normalized small union
// (provider-specific values already collapse to `'unknown'` in the registrant),
// `usage` is plain token counts. The HookBus strips undeclared keys, so this is
// a faithful shape of the interface. Cast to `ZodType<LlmCallOutput>` for
// assignability against `registerService<I,O>`'s `returns?: ZodType<O>`; the
// drift-guard test (`@ax/core` workspace-return-schemas + the llm-anthropic
// return-schemas test) round-trips a fully-populated value.
// ---------------------------------------------------------------------------
export const LlmCallOutputSchema = z.object({
  text: z.string(),
  stopReason: z.union([
    z.literal('end_turn'),
    z.literal('max_tokens'),
    z.literal('tool_use'),
    z.literal('stop_sequence'),
    z.literal('unknown'),
  ]),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
}) as unknown as ZodType<LlmCallOutput>;

// ---------------------------------------------------------------------------
// `llm:usage` — subscriber hook fired after each successful host-side LLM call
// (TASK-692, per-user spend limits).
//
// The provider plugins (`@ax/llm-anthropic`, `@ax/llm-openrouter`) serve the
// host's own helper calls (titles, memory extraction, the skill safety scan).
// They cost money too, so each one reports what it spent through this hook and
// a metering plugin subscribes. The hook name and payload live here, in the
// neutral kernel, so no provider imports another plugin to report and no
// subscriber imports a provider to listen.
//
// Provider-agnostic by construction: `model` is the `provider/model-id` ref the
// call ran on, `usage` is plain token counts (helper calls do not use prompt
// caching, so there is no cache breakdown).
// ---------------------------------------------------------------------------

/** Payload of the `llm:usage` subscriber hook. */
export interface LlmUsageEvent {
  /** The `provider/model-id` ref the call ran on. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Name of the `llm:usage` subscriber hook. */
export const LLM_USAGE_HOOK = 'llm:usage';

/**
 * Report one helper call's usage on `llm:usage`. NEVER throws: metering must
 * not fail the model call it is metering. `bus.fire` already isolates a
 * throwing subscriber, so the try/catch here is for the bus itself failing
 * (a bad ctx, a torn-down kernel); either way the failure is one warn line, not
 * a lost helper call.
 */
export async function fireLlmUsage(
  bus: HookBus,
  ctx: AgentContext,
  event: LlmUsageEvent,
): Promise<void> {
  try {
    await bus.fire(LLM_USAGE_HOOK, ctx, event);
  } catch (err) {
    try {
      ctx.logger.warn('llm_usage_report_failed', { hook: LLM_USAGE_HOOK, model: event.model, err });
    } catch {
      // A logger that throws must not turn a metering hiccup into a failed call.
    }
  }
}
