import { z, type ZodType } from 'zod';
import type { LlmCallOutput } from './types.js';

// ---------------------------------------------------------------------------
// Runtime `returns` contract for the `llm:call:anthropic` service hook
// (ARCH-13, the non-IPC long tail spun out of ARCH-6 #150).
//
// `LlmCallOutput` lives in `@ax/core` types.ts (it's the provider-agnostic
// canonical shape every `llm:call:<provider>` registrant must honour), so its
// schema lives here in core alongside the other neutral kernel shapes — NOT in
// workspace.ts (this isn't a workspace concept). The single registrant today is
// `@ax/llm-anthropic`; a future OpenAI/local registrant imports this same schema
// so its return shape is validated identically.
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
