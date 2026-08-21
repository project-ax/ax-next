// Pure translators between our canonical `LlmCallInput`/`LlmCallOutput` and
// OpenRouter's OpenAI-compatible `/chat/completions` request/response shapes.
// Keeping them here means we can unit-test the mapping without a socket, the
// same split @ax/llm-anthropic uses.

import { PluginError, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { z } from 'zod';
import type { LlmOpenRouterConfig } from './plugin.js';

/**
 * Model used when neither the caller nor the config names one. It's a BARE
 * provider-native slug (no `openrouter/` prefix) because that's what goes on
 * the wire — see `toChatCompletionsRequest`. The fast model is the right
 * default for the same reason Anthropic's is Haiku: the callers who omit a
 * model are the cheap background ones (auto-titling, memory extraction).
 */
export const DEFAULT_MODEL = 'google/gemini-3.7-flash';
export const DEFAULT_MAX_TOKENS = 4096;

export interface ChatCompletionsRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
}

/**
 * `input.model` is a BARE provider-native id (`x-ai/grok-4.6`), never a
 * prefixed `openrouter/...` ref. That's the established `llm:call:<provider>`
 * contract: the hook name already encodes the provider, so the caller has
 * stripped the prefix by the time it reaches us. We deliberately do NOT parse
 * a prefix off it — silently accepting both shapes would mean a caller that
 * passed the full ref got a model id of `openrouter/x-ai/grok-4.6` on the
 * wire, and OpenRouter's 400 for that ("no such model") is a clearer failure
 * than us guessing.
 */
export function toChatCompletionsRequest(
  input: LlmCallInput,
  cfg: LlmOpenRouterConfig,
): ChatCompletionsRequest {
  // OpenAI-compatible APIs carry the system prompt as a leading message with
  // role 'system' rather than a top-level field (the Anthropic shape our
  // canonical `LlmCallInput` was modelled on). This is the whole structural
  // difference between the two request bodies.
  const messages: ChatCompletionsRequest['messages'] =
    input.system !== undefined ? [{ role: 'system', content: input.system }] : [];
  for (const m of input.messages) messages.push({ role: m.role, content: m.content });

  const req: ChatCompletionsRequest = {
    model: input.model ?? cfg.defaultModel ?? DEFAULT_MODEL,
    max_tokens: input.maxTokens ?? cfg.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (input.temperature !== undefined) req.temperature = input.temperature;
  return req;
}

// The response is untrusted bytes off the network, so we shape-check it rather
// than indexing into `any` and hoping. Everything is optional on purpose:
// OpenRouter proxies dozens of upstreams and they differ in what they bother
// to send back (`usage` in particular is omitted on some routes). What we
// refuse to tolerate is a missing `choices` — see `fromChatCompletionsBody`.
const ChatCompletionsResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({ content: z.string().nullable().optional() })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

/** Map OpenAI-style `finish_reason` values onto our normalized small union. */
const STOP_REASONS: Readonly<Record<string, LlmCallOutput['stopReason']>> = Object.freeze({
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
});

export function mapFinishReason(reason: string | null | undefined): LlmCallOutput['stopReason'] {
  if (typeof reason !== 'string') return 'unknown';
  // Own-property check: `reason` is provider-controlled, so a value like
  // 'constructor' must not resolve through Object.prototype to a function.
  const mapped = Object.prototype.hasOwnProperty.call(STOP_REASONS, reason)
    ? STOP_REASONS[reason]
    : undefined;
  // Anything unmapped — 'content_filter', 'error', a vendor-specific value
  // some upstream invented this week — collapses to 'unknown' so subscribers
  // can stay exhaustive over the union.
  return mapped ?? 'unknown';
}

/**
 * Translate a parsed `/chat/completions` body into our canonical output.
 * `pluginName` / `hookName` are threaded in only so the errors we raise name
 * the right owner without this module importing the plugin.
 */
export function fromChatCompletionsBody(
  body: unknown,
  pluginName: string,
  hookName: string,
): LlmCallOutput {
  const parsed = ChatCompletionsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: pluginName,
      hookName,
      message: 'OpenRouter returned a response we could not read as a chat completion',
    });
  }
  const choice = parsed.data.choices?.[0];
  if (choice === undefined) {
    // A 200 with no choices is a malformed answer, not an empty one. Returning
    // `text: ''` here would look like the model chose to say nothing — a
    // silent failure the caller has no way to distinguish from a real reply.
    throw new PluginError({
      code: 'unknown',
      plugin: pluginName,
      hookName,
      message: 'OpenRouter returned a completion with no choices',
    });
  }
  return {
    // `content: null` is legitimate — it's what a tool-call-only turn looks
    // like on an OpenAI-compatible API. Empty text is the honest translation.
    text: choice.message?.content ?? '',
    stopReason: mapFinishReason(choice.finish_reason),
    // Some OpenRouter routes omit usage entirely. Zeros are the neutral
    // answer; the alternative (throwing) would fail turns over accounting.
    usage: {
      inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.data.usage?.completion_tokens ?? 0,
    },
  };
}
